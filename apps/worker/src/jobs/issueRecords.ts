import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  agentsRepository,
  canonicalizeToBytes,
  findAllMessagesBySession,
  hex,
  insertRecord,
  newId,
  sessionsRepository,
  sha256,
  verifyBundle,
  type Evidence,
  type EvidenceMessage,
  type MessageDoc,
  type PlatformSigner,
  type RecordBundle,
  type RecordDoc,
  type RecordStatement,
  type SessionDoc,
} from "@openglass/db";
import type { Db } from "mongodb";
import type { ContentEncryptionDeps } from "../domain/contentEncryptionDeps.js";
import type { Mailer } from "../mailer.js";
import { emailRecordIssuedOwners } from "./notifyOwners.js";
import { PLATFORM_KEY_GENESIS_DATE, trustedPlatformKeys } from "./platformKeys.js";
import { resolveRecordVisibility } from "./recordVisibility.js";

function evidenceMessageOf(m: MessageDoc): EvidenceMessage {
  return {
    envelope: m.envelope,
    hash: m.hash,
    signature: m.signature,
    receivedAt: m.receivedAt.toISOString(),
    platformSignature: m.platformSignature,
    ...("payload" in m ? { payload: m.payload } : {}),
  };
}

function buildEvidence(session: SessionDoc, messages: MessageDoc[]): Evidence {
  return {
    v: 1,
    type: "openglass.evidence",
    offer: session.offer,
    offerSignature: session.offerSignature,
    accept: session.accept!,
    acceptSignature: session.acceptSignature!,
    open: null,
    openSignature: null,
    genesisHash: session.genesisHash!,
    genesisSignature: session.genesisSignature!,
    messages: messages.map(evidenceMessageOf),
    close: session.closing?.statement ? { statement: session.closing.statement, signature: session.closing.signature! } : null,
  };
}

function buildStatement(
  session: SessionDoc,
  recordId: string,
  evidenceSha256: string,
  issuedAt: string,
  visibility: RecordStatement["visibility"],
  retention: RecordStatement["retention"],
): RecordStatement {
  return {
    v: 1,
    type: "openglass.record",
    kind: "session",
    recordId,
    sessionId: session._id,
    mode: session.mode,
    purpose: session.purpose,
    participants: [
      {
        role: "initiator",
        agentId: session.initiator.agentId!,
        ownerId: session.initiator.ownerId!,
        kid: session.initiator.kid!,
        publicKey: session.offer.initiator.publicKey,
      },
      {
        role: "counterparty",
        agentId: session.counterparty.agentId!,
        ownerId: session.counterparty.ownerId!,
        kid: session.counterparty.kid!,
        publicKey: session.accept!.counterparty.publicKey,
      },
    ],
    genesisHash: session.genesisHash!,
    headSeq: session.head.seq,
    headHash: session.head.hash,
    messageCount: session.messageCount,
    activatedAt: session.activatedAt!.toISOString(),
    closedAt: session.closing!.statement?.closedAt ?? issuedAt,
    closeReason: session.closing!.reason,
    closedBy: session.closing!.requestedBy,
    evidenceSha256,
    issuedAt,
    visibility,
    retention,
  };
}

export interface IssueRecordsDeps {
  db: Db;
  s3: S3Client;
  s3Bucket: string;
  signer: PlatformSigner;
  /** See apps/api/src/domain/platformKeys.ts — must match the api container's value. */
  platformKeyValidFrom?: string;
  mailer: Mailer;
  publicUrl: string;
  /** Realignment R1 (docs/SPEC.md §13) — null until CONTENT_ENCRYPTION is configured. */
  contentEncryption: ContentEncryptionDeps | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * SPEC §5.4: picks up `closing` sessions, builds+uploads the evidence bundle, re-verifies
 * it (stopping short of issuing if that fails), signs and inserts the record, and marks
 * the session `closed`. Each step is idempotent, so a crashed/restarted worker just
 * re-does completed steps harmlessly — `insertRecord` treats a duplicate `sessionId` as
 * "already issued" rather than erroring.
 */
export async function issueRecords(deps: IssueRecordsDeps): Promise<{ issued: number; skipped: number }> {
  const sessions = sessionsRepository(deps.db);
  const agents = agentsRepository(deps.db);
  const closing = await sessions.findClosing();
  const log = deps.log ?? (() => {});

  let issued = 0;
  let skipped = 0;
  for (const session of closing) {
    const messages = await findAllMessagesBySession(deps.db, session._id);
    const evidence = buildEvidence(session, messages);

    const recordId = newId("rec");
    const issuedAt = new Date().toISOString();
    // The initiator's own retention preference governs a private session record — they're
    // the one who opted into visibility: "private" in the first place (the default is
    // "sealed"), so their agent's own override (or the platform default) applies rather
    // than picking between two potentially-different owners' settings.
    const initiatorAgent = await agents.findById(session.initiator.agentId!);
    const resolved = await resolveRecordVisibility({
      requestedVisibility: session.visibility,
      defaultVisibility: "sealed",
      ownerRetentionDaysOverride: initiatorAgent?.privateRetentionDays,
      issuedAt,
      evidence,
      contentEncryption: deps.contentEncryption,
    });

    const evidenceBytes = canonicalizeToBytes(evidence);
    const evidenceSha256 = hex(sha256(evidenceBytes));
    const statement = buildStatement(session, recordId, evidenceSha256, issuedAt, resolved.visibility, resolved.statementRetention);
    const statementHashBytes = sha256(canonicalizeToBytes(statement));
    const statementHash = hex(statementHashBytes);
    const platformSignature = await deps.signer.sign("record", statementHashBytes);

    const trusted = await trustedPlatformKeys(deps.signer, deps.platformKeyValidFrom ?? PLATFORM_KEY_GENESIS_DATE);
    const bundle: RecordBundle = { v: 1, type: "openglass.bundle", record: { statement, statementHash, platformSignature }, evidence, platformKeys: trusted };
    const verification = verifyBundle(bundle, trusted);
    if (!verification.valid) {
      log("record verification failed before issuance — skipping this cycle", { sessionId: session._id, errors: verification.errors });
      skipped++;
      continue;
    }

    const s3Key = `records/${recordId}/evidence.json`;
    await deps.s3.send(new PutObjectCommand({ Bucket: deps.s3Bucket, Key: s3Key, Body: evidenceBytes, ContentType: "application/json" }));

    const recordDoc: RecordDoc = {
      _id: recordId,
      sessionId: session._id,
      statement,
      statementHash,
      platformSignature,
      evidence: { s3Key, sha256: evidenceSha256, bytes: evidenceBytes.byteLength },
      participantAgentIds: [session.initiator.agentId!, session.counterparty.agentId!],
      participantOwnerIds: [session.initiator.ownerId!, session.counterparty.ownerId!],
      createdAt: new Date(),
      visibility: resolved.visibility,
      sealedState: resolved.sealedState,
      retention: resolved.docRetention,
      encryption: resolved.encryption,
    };
    const inserted = await insertRecord(deps.db, recordDoc);

    await sessions.update(session._id, { status: "closed", closedAt: new Date(), recordId: inserted._id });
    issued++;

    await emailRecordIssuedOwners(deps.db, deps.mailer, inserted, deps.publicUrl, log);
  }
  return { issued, skipped };
}
