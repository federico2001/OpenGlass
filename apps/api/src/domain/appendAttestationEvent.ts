import {
  attestationsRepository,
  base64UrlDecode,
  canonicalizeToBytes,
  hex,
  insertMessage,
  newId,
  sha256,
  verifySignature,
  type AgentDoc,
  type MessageDoc,
  type MessageEnvelope,
  type PlatformSigner,
  type Signature,
} from "@openglass/db";
import type { Db, MongoClient } from "mongodb";
import { computeCountersignDigest, computeMessageHash } from "./chain.js";
import { withinClockSkew } from "./genesis.js";

const EVENT_LIMIT = 10_000;
const MAX_RELAY_PAYLOAD_BYTES = 256 * 1024;

export interface AppendAttestationEventBody {
  envelope: MessageEnvelope;
  hash: string;
  signature: Signature;
  payload?: unknown;
}

export interface AppendAttestationEventError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type AppendAttestationEventResult =
  | { ok: true; event: MessageDoc; head: { seq: number; hash: string } }
  | { ok: false; error: AppendAttestationEventError };

/**
 * The one-party counterpart to `appendMessage` (Prompt 20) — same hash-chain algorithm
 * (SPEC §7.3), same `messages` collection and `MessageEnvelope`/`MessageDoc` shapes (see
 * the field-reuse notes in protocol.ts: `envelope.sessionId` holds the attestation id
 * here), just without a second participant to pin the sender against — the sender must
 * always be the attestation's own attestor agent.
 */
export async function appendAttestationEvent(
  deps: { db: Db; mongoClient: MongoClient; signer: PlatformSigner },
  agentDoc: AgentDoc,
  attestationId: string,
  body: AppendAttestationEventBody,
): Promise<AppendAttestationEventResult> {
  const attestations = attestationsRepository(deps.db);
  const { envelope, hash, signature, payload } = body;

  const attestation = await attestations.findById(attestationId);
  if (!attestation || attestation.attestor.agentId !== agentDoc._id) {
    return { ok: false, error: { status: 404, code: "not_found", message: "Attestation not found" } };
  }
  if (attestation.status !== "active") {
    return { ok: false, error: { status: 409, code: "attestation_not_active", message: "Attestation is not active" } };
  }
  if (envelope.sessionId !== attestation._id) {
    return { ok: false, error: { status: 422, code: "hash_mismatch", message: "envelope.sessionId mismatch" } };
  }

  const expectedSeq = attestation.head.seq + 1;
  const expectedPrevHash = attestation.head.hash ?? attestation.genesisHash;
  if (envelope.seq !== expectedSeq || envelope.prevHash !== expectedPrevHash) {
    return { ok: false, error: { status: 409, code: "chain_conflict", message: "Head has moved", details: { head: attestation.head } } };
  }
  if (envelope.sender.agentId !== agentDoc._id || envelope.sender.kid !== attestation.attestor.kid) {
    return { ok: false, error: { status: 422, code: "key_not_pinned", message: "envelope.sender must be the key pinned for this attestation" } };
  }

  if (attestation.mode === "relay") {
    if (payload === undefined) return { ok: false, error: { status: 422, code: "payload_required", message: "payload is required in relay mode" } };
    const payloadBytes = canonicalizeToBytes(payload);
    if (payloadBytes.byteLength > MAX_RELAY_PAYLOAD_BYTES) {
      return { ok: false, error: { status: 413, code: "payload_too_large", message: "payload exceeds 256 KiB" } };
    }
    if (envelope.payloadHash !== hex(sha256(payloadBytes))) {
      return { ok: false, error: { status: 422, code: "payload_hash_mismatch", message: "payloadHash does not match the payload" } };
    }
  } else if (payload !== undefined) {
    return { ok: false, error: { status: 422, code: "payload_not_allowed", message: "payload is not allowed in notary mode" } };
  }

  if (!withinClockSkew(envelope.sentAt)) {
    return { ok: false, error: { status: 422, code: "sent_at_skew", message: "envelope.sentAt is outside the allowed ±300s window" } };
  }

  const { hashBytes, hash: computedHash } = computeMessageHash(expectedPrevHash, envelope);
  if (computedHash !== hash) return { ok: false, error: { status: 422, code: "hash_mismatch", message: "hash does not match prevHash + envelope" } };

  const key = agentDoc.keys.find((k) => k.kid === attestation.attestor.kid);
  const sigVerified =
    !!key && verifySignature({ alg: "Ed25519", kid: key.kid, publicKey: base64UrlDecode(key.publicKey) }, "message", hashBytes, signature);
  if (!sigVerified) return { ok: false, error: { status: 422, code: "invalid_signature", message: "signature does not verify" } };

  const receivedAt = new Date();
  const countersignDigest = computeCountersignDigest(computedHash, signature.sig, receivedAt.toISOString());
  const platformSignature = await deps.signer.sign("countersign", countersignDigest);

  const eventDoc: MessageDoc = {
    _id: newId("msg"),
    sessionId: attestation._id,
    seq: envelope.seq,
    envelope,
    hash: computedHash,
    signature,
    receivedAt,
    platformSignature,
    ...(attestation.mode === "relay" ? { payload } : {}),
  };
  const nextEventCount = attestation.eventCount + 1;
  const nextExpiresAt = new Date(receivedAt.getTime() + attestation.idleTimeoutSec * 1000);

  const dbSession = deps.mongoClient.startSession();
  let conflict = false;
  try {
    await dbSession.withTransaction(async () => {
      await insertMessage(deps.db, eventDoc, { session: dbSession });
      const updated = await attestations.advanceHead(
        attestation._id,
        attestation.head.seq,
        { head: { seq: envelope.seq, hash: computedHash }, eventCount: nextEventCount, lastActivityAt: receivedAt, expiresAt: nextExpiresAt },
        { session: dbSession },
      );
      if (!updated) {
        conflict = true;
        throw new Error("chain_conflict");
      }
    });
  } catch (err) {
    if (!conflict) throw err;
  } finally {
    await dbSession.endSession();
  }
  if (conflict) {
    const current = await attestations.findById(attestation._id);
    return { ok: false, error: { status: 409, code: "chain_conflict", message: "Head has moved", details: { head: current?.head } } };
  }

  if (nextEventCount >= EVENT_LIMIT) {
    await attestations.update(attestation._id, {
      status: "closing",
      closing: { reason: "message_limit", requestedBy: null, statement: null, signature: null, requestedAt: new Date() },
    });
  }

  return { ok: true, event: eventDoc, head: { seq: envelope.seq, hash: computedHash } };
}
