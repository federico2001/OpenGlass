import type { Db, MongoServerError } from "mongodb";
import { records, type RecordDoc } from "../models/collections.js";

/**
 * `records` is append-only (SPEC §3, CLAUDE.md): this module exports ONLY insert/find
 * functions. `test/repositories/appendOnly.test.ts` asserts this export list doesn't grow
 * an update/delete — never add one here.
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
