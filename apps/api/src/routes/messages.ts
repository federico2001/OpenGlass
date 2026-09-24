import {
  MessageEnvelope,
  Signature,
  base64UrlDecode,
  canonicalizeToBytes,
  findMessagesBySession,
  hex,
  insertMessage,
  newId,
  sessionsRepository,
  sha256,
  verifySignature,
  type MessageDoc,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessSession, participantOf } from "../domain/access.js";
import { computeCountersignDigest, computeMessageHash } from "../domain/chain.js";
import { withinClockSkew } from "../domain/genesis.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

const MESSAGE_LIMIT = 10_000;
const MAX_RELAY_PAYLOAD_BYTES = 256 * 1024;

const SendMessageBody = z.strictObject({
  envelope: MessageEnvelope,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: Signature,
  payload: z.unknown().optional(),
});

function messageView(doc: MessageDoc) {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    seq: doc.seq,
    envelope: doc.envelope,
    hash: doc.hash,
    signature: doc.signature,
    receivedAt: doc.receivedAt.toISOString(),
    platformSignature: doc.platformSignature,
    ...("payload" in doc ? { payload: doc.payload } : {}),
  };
}

export function registerMessagesRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const sessions = sessionsRepository(deps.db);

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/messages",
    {
      preHandler: [
        verifyAgentRequest(deps.db),
        rateLimit(deps.db, "message_send_per_agent", (req) => req.agent!.doc._id),
        rateLimit(deps.db, "message_send_per_session", (req) => `${req.agent!.doc._id}:${(req.params as { sessionId: string }).sessionId}`),
      ],
    },
    async (req, reply) => {
      const body = parseOrError(SendMessageBody, req.body, reply);
      if (!body) return;
      const { envelope, hash, signature, payload } = body;
      const agentId = req.agent!.doc._id;

      const session = await sessions.findById(req.params.sessionId);
      const participant = session && participantOf(session, agentId);
      if (!session || !participant) return sendError(reply, 404, "not_found", "Session not found");
      if (session.status !== "active") return sendError(reply, 409, "session_not_active", "Session is not active");
      if (envelope.sessionId !== session._id) return sendError(reply, 422, "hash_mismatch", "envelope.sessionId mismatch");

      const expectedSeq = session.head.seq + 1;
      const expectedPrevHash = session.head.hash ?? session.genesisHash!;
      if (envelope.seq !== expectedSeq || envelope.prevHash !== expectedPrevHash) {
        return sendError(reply, 409, "chain_conflict", "Head has moved", { head: session.head });
      }
      if (envelope.sender.agentId !== agentId || envelope.sender.kid !== participant.kid) {
        return sendError(reply, 422, "key_not_pinned", "envelope.sender must be the key pinned for this session");
      }

      if (session.mode === "relay") {
        if (payload === undefined) return sendError(reply, 422, "payload_required", "payload is required in relay mode");
        const payloadBytes = canonicalizeToBytes(payload);
        if (payloadBytes.byteLength > MAX_RELAY_PAYLOAD_BYTES) {
          return sendError(reply, 413, "payload_too_large", "payload exceeds 256 KiB");
        }
        if (envelope.payloadHash !== hex(sha256(payloadBytes))) {
          return sendError(reply, 422, "payload_hash_mismatch", "payloadHash does not match the payload");
        }
      } else if (payload !== undefined) {
        return sendError(reply, 422, "payload_not_allowed", "payload is not allowed in notary mode");
      }

      if (!withinClockSkew(envelope.sentAt)) {
        return sendError(reply, 422, "sent_at_skew", "envelope.sentAt is outside the allowed ±300s window");
      }

      const { hashBytes, hash: computedHash } = computeMessageHash(expectedPrevHash, envelope);
      if (computedHash !== hash) return sendError(reply, 422, "hash_mismatch", "hash does not match prevHash + envelope");

      const key = req.agent!.doc.keys.find((k) => k.kid === participant.kid);
      const sigVerified =
        !!key &&
        verifySignature({ alg: "Ed25519", kid: key.kid, publicKey: base64UrlDecode(key.publicKey) }, "message", hashBytes, signature);
      if (!sigVerified) return sendError(reply, 422, "invalid_signature", "signature does not verify");

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
        return sendError(reply, 409, "chain_conflict", "Head has moved", { head: current?.head });
      }

      if (nextMessageCount >= MESSAGE_LIMIT) {
        await sessions.update(session._id, {
          status: "closing",
          closing: { reason: "message_limit", requestedBy: null, statement: null, signature: null, requestedAt: new Date() },
        });
      }

      return reply.code(201).send({ message: messageView(messageDoc), head: { seq: envelope.seq, hash: computedHash } });
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/messages",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const session = await sessions.findById(req.params.sessionId);
      if (!session || !canAccessSession(session, req)) return sendError(reply, 404, "not_found", "Session not found");
      const q = req.query as { afterSeq?: string; limit?: string };
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const afterSeq = Math.max(Number(q.afterSeq) || 0, 0);
      const items = await findMessagesBySession(deps.db, session._id, { afterSeq, limit });
      return { items: items.map(messageView), nextCursor: items.length === limit ? items[items.length - 1]!.seq : null };
    },
  );
}
