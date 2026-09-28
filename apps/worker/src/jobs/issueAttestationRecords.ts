import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  agentsRepository,
  attestationsRepository,
  canonicalizeToBytes,
  findAllMessagesBySession,
  hex,
  insertRecord,
  newId,
  sha256,
  verifyBundle,
  type AttestationDoc,
  type Evidence,
  type EvidenceMessage,
  type MessageDoc,
  type PlatformSigner,
  type RecordBundle,
  type RecordDoc,
  type RecordStatement,
} from "@openglass/db";
import type { Db } from "mongodb";
import type { ContentEncryptionDeps } from "../domain/contentEncryptionDeps.js";
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

function buildEvidence(attestation: AttestationDoc, events: MessageDoc[]): Evidence {
  return {
    v: 1,
    type: "openglass.evidence",
    offer: null,
    offerSignature: null,
    accept: null,
    acceptSignature: null,
    open: attestation.open,
    openSignature: attestation.openSignature,
    genesisHash: attestation.genesisHash,
    genesisSignature: attestation.genesisSignature,
    messages: events.map(evidenceMessageOf),
    close: attestation.closing?.statement ? { statement: attestation.closing.statement, signature: attestation.closing.signature! } : null,
  };
}

function buildStatement(
  attestation: AttestationDoc,
  recordId: string,
  evidenceSha256: string,
  issuedAt: string,
  visibility: RecordStatement["visibility"],
  retention: RecordStatement["retention"],
): RecordStatement {
  return {
    v: 1,
    type: "openglass.record",
    kind: "attestation",
    recordId,
    sessionId: attestation._id,
    mode: attestation.mode,
    purpose: attestation.purpose,
    participants: [
      {
        role: "attestor",
        agentId: attestation.attestor.agentId,
        ownerId: attestation.attestor.ownerId,
        kid: attestation.attestor.kid,
        publicKey: attestation.open.attestor.publicKey,
      },
    ],
    genesisHash: attestation.genesisHash,
    headSeq: attestation.head.seq,
    headHash: attestation.head.hash,
    messageCount: attestation.eventCount,
    activatedAt: attestation.activatedAt.toISOString(),
    closedAt: attestation.closing!.statement?.closedAt ?? issuedAt,
    closeReason: attestation.closing!.reason,
    closedBy: attestation.closing!.requestedBy,
    evidenceSha256,
    issuedAt,
    visibility,
    retention,
  };
}

export interface IssueAttestationRecordsDeps {
  db: Db;
  s3: S3Client;
  s3Bucket: string;
  signer: PlatformSigner;
  platformKeyValidFrom?: string;
  /** Realignment R1 (docs/SPEC.md §13) — null until CONTENT_ENCRYPTION is configured. */
  contentEncryption: ContentEncryptionDeps | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * The one-party counterpart to `issueRecords` (Prompt 20) — same idempotent
 * build-evidence / verify-before-issuing / sign / insert / mark-closed flow, just over
 * `attestations` instead of `sessions`. No owner-notification email yet (no second party
 * to also notify) — the attestor's own owner can already see it issued via the dashboard.
 */
export async function issueAttestationRecords(deps: IssueAttestationRecordsDeps): Promise<{ issued: number; skipped: number }> {
  const attestations = attestationsRepository(deps.db);
  const agents = agentsRepository(deps.db);
  const closing = await attestations.findClosing();
  const log = deps.log ?? (() => {});

  let issued = 0;
  let skipped = 0;
  for (const attestation of closing) {
    const events = await findAllMessagesBySession(deps.db, attestation._id);
    const evidence = buildEvidence(attestation, events);

    const recordId = newId("rec");
    const issuedAt = new Date().toISOString();
    const attestorAgent = await agents.findById(attestation.attestor.agentId);
    const resolved = await resolveRecordVisibility({
      requestedVisibility: attestation.visibility,
      defaultVisibility: "private",
      ownerRetentionDaysOverride: attestorAgent?.privateRetentionDays,
      issuedAt,
      evidence,
      contentEncryption: deps.contentEncryption,
    });

    const evidenceBytes = canonicalizeToBytes(evidence);
    const evidenceSha256 = hex(sha256(evidenceBytes));
    const statement = buildStatement(attestation, recordId, evidenceSha256, issuedAt, resolved.visibility, resolved.statementRetention);
    const statementHashBytes = sha256(canonicalizeToBytes(statement));
    const statementHash = hex(statementHashBytes);
    const platformSignature = await deps.signer.sign("record", statementHashBytes);

    const trusted = await trustedPlatformKeys(deps.signer, deps.platformKeyValidFrom ?? PLATFORM_KEY_GENESIS_DATE);
    const bundle: RecordBundle = { v: 1, type: "openglass.bundle", record: { statement, statementHash, platformSignature }, evidence, platformKeys: trusted };
    const verification = verifyBundle(bundle, trusted);
    if (!verification.valid) {
      log("attestation record verification failed before issuance — skipping this cycle", {
        attestationId: attestation._id,
        errors: verification.errors,
      });
      skipped++;
      continue;
    }

    const s3Key = `records/${recordId}/evidence.json`;
    await deps.s3.send(new PutObjectCommand({ Bucket: deps.s3Bucket, Key: s3Key, Body: evidenceBytes, ContentType: "application/json" }));

    const recordDoc: RecordDoc = {
      _id: recordId,
      sessionId: attestation._id,
      statement,
      statementHash,
      platformSignature,
      evidence: { s3Key, sha256: evidenceSha256, bytes: evidenceBytes.byteLength },
      participantAgentIds: [attestation.attestor.agentId],
      participantOwnerIds: [attestation.attestor.ownerId],
      createdAt: new Date(),
      visibility: resolved.visibility,
      sealedState: resolved.sealedState,
      retention: resolved.docRetention,
      encryption: resolved.encryption,
    };
    const inserted = await insertRecord(deps.db, recordDoc);

    await attestations.update(attestation._id, { status: "closed", closedAt: new Date(), recordId: inserted._id });
    issued++;
  }
  return { issued, skipped };
}
