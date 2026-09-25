import {
  base64UrlDecode,
  canonicalizeToBytes,
  hex,
  insertMessage,
  newId,
  sessionsRepository,
  sha256,
  verifySignature,
  type AgentDoc,
  type MessageDoc,
  type MessageEnvelope,
  type PlatformSigner,
  type Signature,
} from "@openglass/db";
import type { Db, MongoClient } from "mongodb";
import { participantOf } from "./access.js";
import { computeCountersignDigest, computeMessageHash } from "./chain.js";
import { withinClockSkew } from "./genesis.js";

const MESSAGE_LIMIT = 10_000;
const MAX_RELAY_PAYLOAD_BYTES = 256 * 1024;

export interface AppendMessageBody {
  envelope: MessageEnvelope;
  hash: string;
  signature: Signature;
  payload?: unknown;
}

export interface AppendMessageError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type AppendMessageResult =
  | { ok: true; message: MessageDoc; head: { seq: number; hash: string } }
  | { ok: false; error: AppendMessageError };

/**
 * The whole POST /v1/sessions/{id}/messages chain-append algorithm (SPEC §5.3, §7.3),
 * factored out so the REST route and the WS `message.send` frame handler run the exact
 * same logic rather than two copies that could drift — this is the code that actually
 * enforces the hash chain, so there must be exactly one implementation of it.
 */
export async function appendMessage(
  deps: { db: Db; mongoClient: MongoClient; signer: PlatformSigner },
  agentDoc: AgentDoc,
  sessionId: string,
  body: AppendMessageBody,
): Promise<AppendMessageResult> {
  const sessions = sessionsRepository(deps.db);
  const { envelope, hash, signature, payload } = body;

  const session = await sessions.findById(sessionId);
  const participant = session && participantOf(session, agentDoc._id);
  if (!session || !participant) return { ok: false, error: { status: 404, code: "not_found", message: "Session not found" } };
  if (session.status !== "active") return { ok: false, error: { status: 409, code: "session_not_active", message: "Session is not active" } };
  if (envelope.sessionId !== session._id) {
    return { ok: false, error: { status: 422, code: "hash_mismatch", message: "envelope.sessionId mismatch" } };
  }

  const expectedSeq = session.head.seq + 1;
  const expectedPrevHash = session.head.hash ?? session.genesisHash!;
  if (envelope.seq !== expectedSeq || envelope.prevHash !== expectedPrevHash) {
    return { ok: false, error: { status: 409, code: "chain_conflict", message: "Head has moved", details: { head: session.head } } };
  }
  if (envelope.sender.agentId !== agentDoc._id || envelope.sender.kid !== participant.kid) {
    return { ok: false, error: { status: 422, code: "key_not_pinned", message: "envelope.sender must be the key pinned for this session" } };
  }

  if (session.mode === "relay") {
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

  const key = agentDoc.keys.find((k) => k.kid === participant.kid);
  const sigVerified =
    !!key && verifySignature({ alg: "Ed25519", kid: key.kid, publicKey: base64UrlDecode(key.publicKey) }, "message", hashBytes, signature);
  if (!sigVerified) return { ok: false, error: { status: 422, code: "invalid_signature", message: "signature does not verify" } };

  const receivedAt = new Date();
  const countersignDigest = computeCountersignDigest(computedHash, signature.sig, receivedAt.toISOString());
  const platformSignature = await deps.signer.sign("countersign", countersignDigest);

  const messageDoc: MessageDoc = {
    _id: newId("msg"),
    sessionId: session._id,
    seq: envelope.seq,
    envelope,
    hash: computedHash,
    signature,
    receivedAt,
    platformSignature,
    ...(session.mode === "relay" ? { payload } : {}),
  };
  const nextMessageCount = session.messageCount + 1;
  const nextExpiresAt = new Date(receivedAt.getTime() + session.idleTimeoutSec * 1000);

  // Insert + conditional head advance happen atomically (SPEC §3.3: "runs in one
  // transaction with the messages insert, and is conditional on the head not having
  // moved" — this is what actually enforces the append-only hash chain under races).
  const dbSession = deps.mongoClient.startSession();
  let conflict = false;
  try {
    await dbSession.withTransaction(async () => {
      await insertMessage(deps.db, messageDoc, { session: dbSession });
      const updated = await sessions.advanceHead(
        session._id,
        session.head.seq,
        { head: { seq: envelope.seq, hash: computedHash }, messageCount: nextMessageCount, lastActivityAt: receivedAt, expiresAt: nextExpiresAt },
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
    const current = await sessions.findById(session._id);
    return { ok: false, error: { status: 409, code: "chain_conflict", message: "Head has moved", details: { head: current?.head } } };
  }

  if (nextMessageCount >= MESSAGE_LIMIT) {
    await sessions.update(session._id, {
      status: "closing",
      closing: { reason: "message_limit", requestedBy: null, statement: null, signature: null, requestedAt: new Date() },
    });
  }

  return { ok: true, message: messageDoc, head: { seq: envelope.seq, hash: computedHash } };
}
