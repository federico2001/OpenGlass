import type { Db, MongoServerError } from "mongodb";
import { records, type RecordDoc } from "../models/collections.js";

/**
 * `records` is append-only (SPEC §3, CLAUDE.md): this module exports ONLY insert/find
 * functions, plus the deliberate exceptions documented on `shredContent` and the
 * `*Seal`/`*Unseal` functions below — each touches only its own access-control sub-field
 * (`encryption`, `sealedState`), never `statement`/`evidence`/anything a signature or hash
 * covers. `test/repositories/appendOnly.test.ts` asserts this export list doesn't grow any
 * other update/delete — never add one without the same scrutiny.
 */

export const DUPLICATE_KEY_ERROR_CODE = 11000;

/** Returns the existing record instead of throwing if `sessionId` already has one
 * (SPEC §5.4 step 4: "treats the record as already issued"). */
export async function insertRecord(db: Db, doc: RecordDoc): Promise<RecordDoc> {
  const col = db.collection<RecordDoc>(records.name);
  try {
    await col.insertOne(doc);
    return doc;
  } catch (err) {
    if ((err as MongoServerError).code === DUPLICATE_KEY_ERROR_CODE) {
      const existing = await col.findOne({ sessionId: doc.sessionId });
      if (existing) return existing;
    }
    throw err;
  }
}

export function findRecordById(db: Db, id: string): Promise<RecordDoc | null> {
  return db.collection<RecordDoc>(records.name).findOne({ _id: id });
}

export function findRecordBySession(db: Db, sessionId: string): Promise<RecordDoc | null> {
  return db.collection<RecordDoc>(records.name).findOne({ sessionId });
}

export function listRecordsForOwner(db: Db, ownerId: string, opts: { limit: number; cursor?: string }): Promise<RecordDoc[]> {
  return db
    .collection<RecordDoc>(records.name)
    .find({ participantOwnerIds: ownerId, ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(opts.limit)
    .toArray();
}

/** Records for any of these agents — used for human viewer access (Prompt 6), where a
 * grant is scoped to specific agents rather than an owner. An empty `agentIds` matches
 * nothing, which `$in` already does on its own. */
export function listRecordsForAgents(db: Db, agentIds: string[], opts: { limit: number; cursor?: string }): Promise<RecordDoc[]> {
  return db
    .collection<RecordDoc>(records.name)
    .find({ participantAgentIds: { $in: agentIds }, ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(opts.limit)
    .toArray();
}

export type ShredReason = "retention_expired" | "owner_deleted";

/**
 * The one deliberate exception to `records`' append-only rule (docs/SPEC.md §13.3): crypto-
 * shreds a `visibility: "private"` record's content by permanently clearing its wrapped data-key
 * ciphertext, so every payload that key encrypted becomes unrecoverable by anyone — KMS access
 * included — while every other field on this document, and every byte of the immutable S3
 * evidence it points at, stays exactly as issued. Touches only `encryption`'s own sub-fields;
 * never `statement`, `evidence`, or anything a signature/hash covers.
 *
 * Idempotent: shredding an already-shredded record matches nothing and is reported as success
 * (the end state — no recoverable key — is already true), so callers (the retention sweep job,
 * an owner-initiated delete) don't need to special-case a double-shred.
 */
export async function shredContent(db: Db, recordId: string, reason: ShredReason): Promise<boolean> {
  const col = db.collection<RecordDoc>(records.name);
  const result = await col.updateOne(
    { _id: recordId, "encryption.shredded": false },
    { $set: { "encryption.dataKeyCiphertext": null, "encryption.shredded": true, "encryption.shreddedAt": new Date(), "encryption.shreddedReason": reason } },
  );
  if (result.matchedCount > 0) return true;
  const existing = await col.findOne({ _id: recordId });
  return existing?.encryption?.shredded === true;
}

/**
 * `visibility: "sealed"` consent-to-unseal state machine (docs/SPEC.md §13.2), the second
 * deliberate exception to append-only (see the module doc comment above). An owner starts
 * the ceremony; `requestedBy` implicitly counts as that owner's own approval. No-op (returns
 * null) unless the record is currently plain `sealed` — callers surface that as "already
 * requested" / "not sealed" rather than silently reinterpreting a stale click.
 */
export function requestUnseal(db: Db, recordId: string, ownerId: string): Promise<RecordDoc | null> {
  return db.collection<RecordDoc>(records.name).findOneAndUpdate(
    { _id: recordId, visibility: "sealed", "sealedState.status": "sealed" },
    {
      $set: {
        sealedState: { status: "unseal_requested", requestedBy: ownerId, approvals: [ownerId], unsealedAt: null, disputedBy: null, disputedAt: null },
      },
    },
    { returnDocument: "after" },
  );
}

/**
 * Adds `ownerId`'s approval to a pending unseal request and, once every one of the record's
 * `participantOwnerIds` has approved, flips `sealedState.status` to `unsealed`. Two owners
 * approving at the exact same instant could each read a pre-completion state and both issue
 * the completing update — harmless (both converge on the same final `unsealed` document,
 * `unsealedAt` differing by at most the race window), so this accepts that instead of adding
 * transaction machinery for a two-human-clicking-at-once edge case. Idempotent: approving
 * again after already having approved is a no-op ($addToSet).
 */
export async function approveUnseal(db: Db, recordId: string, ownerId: string): Promise<RecordDoc | null> {
  const col = db.collection<RecordDoc>(records.name);
  const afterApproval = await col.findOneAndUpdate(
    { _id: recordId, "sealedState.status": "unseal_requested" },
    { $addToSet: { "sealedState.approvals": ownerId } },
    { returnDocument: "after" },
  );
  if (!afterApproval?.sealedState) return afterApproval;
  const allApproved = afterApproval.participantOwnerIds.every((id) => afterApproval.sealedState!.approvals.includes(id));
  if (!allApproved) return afterApproval;
  const unsealed = await col.findOneAndUpdate(
    { _id: recordId, "sealedState.status": "unseal_requested" },
    { $set: { "sealedState.status": "unsealed", "sealedState.unsealedAt": new Date() } },
    { returnDocument: "after" },
  );
  return unsealed ?? afterApproval;
}

/**
 * Force-unseals a `visibility: "sealed"` record for fairness (docs/SPEC.md §13.2): either
 * owner can raise a dispute without the other's consent, immediately granting full-content
 * access to both sides (see the bundle route's `sealedState.status !== "sealed" &&
 * sealedState.status !== "unseal_requested"` check). No-op (returns null) once the record is
 * already `unsealed` — nothing left to force open by that point.
 */
export function disputeSeal(db: Db, recordId: string, ownerId: string): Promise<RecordDoc | null> {
  return db.collection<RecordDoc>(records.name).findOneAndUpdate(
    { _id: recordId, visibility: "sealed", "sealedState.status": { $ne: "unsealed" } },
    { $set: { "sealedState.status": "disputed", "sealedState.disputedBy": ownerId, "sealedState.disputedAt": new Date() } },
    { returnDocument: "after" },
  );
}
