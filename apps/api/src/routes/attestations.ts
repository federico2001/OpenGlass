import {
  AttestationOpen,
  CloseStatement,
  MessageEnvelope,
  Signature,
  attestationsRepository,
  base64UrlDecode,
  canonicalizeToBytes,
  findMessagesBySession,
  sha256,
  verifySignature,
  type AttestationDoc,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessAttestation } from "../domain/access.js";
import { appendAttestationEvent } from "../domain/appendAttestationEvent.js";
import { computeAttestationGenesisHash } from "../domain/attestationGenesis.js";
import { attestationView } from "../domain/attestationViews.js";
import { messageView } from "../domain/messageViews.js";
import { withinClockSkew } from "../domain/genesis.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { requireClaimed } from "../plugins/requireClaimed.js";
import type { ServerDeps } from "../server.js";

const MIN_IDLE_SEC = 60;
const MAX_IDLE_SEC = 604800;
const DEFAULT_IDLE_SEC = 86400;

const OpenAttestationBody = z.strictObject({
  open: AttestationOpen,
  openSignature: Signature,
  idleTimeoutSec: z.int().min(MIN_IDLE_SEC).max(MAX_IDLE_SEC).optional(),
});
const AppendEventBody = z.strictObject({
  envelope: MessageEnvelope,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: Signature,
  payload: z.unknown().optional(),
});
const CloseAttestationBody = z.strictObject({ statement: CloseStatement, signature: Signature });

export function registerAttestationsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const attestations = attestationsRepository(deps.db);

  // Prompt 20: POST /v1/attestations — agent-signed open. No counterparty, no invite, no
  // accept step: the attestation activates the instant the platform countersigns the
  // open statement's hash as its genesis, the same role offer+accept's combined hash
  // plays for a session (SPEC §7.2 vs §12).
  app.post(
    "/v1/attestations",
    {
      preHandler: [verifyAgentRequest(deps.db), requireClaimed, rateLimit(deps.db, "session_create", (req) => req.agent!.doc._id)],
    },
    async (req, reply) => {
      const body = parseOrError(OpenAttestationBody, req.body, reply);
      if (!body) return;
      const { open, openSignature } = body;
      const attestor = req.agent!.doc;

      if (open.attestor.agentId !== attestor._id) {
        return sendError(reply, 422, "open_invalid", "open.attestor.agentId must be the authenticated agent");
      }
      const key = attestor.keys.find((k) => k.kid === open.attestor.kid);
      if (!key || key.revokedAt || key.publicKey !== open.attestor.publicKey) {
        return sendError(reply, 422, "open_invalid", "open.attestor kid/publicKey must match an unrevoked key");
      }
      const openVerified = verifySignature(
        { alg: "Ed25519", kid: key.kid, publicKey: base64UrlDecode(key.publicKey) },
        "attestation_open",
        sha256(canonicalizeToBytes(open)),
        openSignature,
      );
      if (!openVerified) return sendError(reply, 422, "open_invalid", "openSignature does not verify");
      if (!withinClockSkew(open.createdAt)) {
        return sendError(reply, 422, "open_invalid", "open.createdAt is outside the allowed ±300s window");
      }
      if (await attestations.findById(open.attestationId)) {
        return sendError(reply, 409, "attestation_id_taken", "This attestationId is already in use");
      }

      const { genesisHashBytes, genesisHash } = computeAttestationGenesisHash(open, openSignature);
      const genesisSignature = await deps.signer.sign("genesis", genesisHashBytes);

      const now = new Date();
      const idleTimeoutSec = body.idleTimeoutSec ?? DEFAULT_IDLE_SEC;
      const doc: AttestationDoc = {
        _id: open.attestationId,
        mode: open.mode,
        status: "active",
        purpose: open.purpose,
        attestor: { agentId: attestor._id, ownerId: attestor.ownerId!, kid: key.kid }, // requireClaimed guarantees non-null
        open,
        openSignature,
        genesisHash,
        genesisSignature,
        head: { seq: 0, hash: null },
        eventCount: 0,
        idleTimeoutSec,
        createdAt: now,
        activatedAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + idleTimeoutSec * 1000),
        closing: null,
        closedAt: null,
        recordId: null,
      };
      await attestations.insert(doc);
      return reply.code(201).send({ attestation: attestationView(doc) });
    },
  );

  app.get("/v1/attestations", { preHandler: verifyAgentRequest(deps.db) }, async (req) => {
    const q = req.query as { status?: string; cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const items = await attestations.listByAttestor("attestor.agentId", req.agent!.doc._id, {
      limit,
      cursor: q.cursor,
      status: q.status as AttestationDoc["status"] | undefined,
    });
    return { items: items.map(attestationView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  app.get<{ Params: { attestationId: string } }>(
    "/v1/attestations/:attestationId",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const attestation = await attestations.findById(req.params.attestationId);
      if (!attestation || !canAccessAttestation(attestation, req)) return sendError(reply, 404, "not_found", "Attestation not found");
      return { attestation: attestationView(attestation) };
    },
  );

  app.post<{ Params: { attestationId: string } }>(
    "/v1/attestations/:attestationId/events",
    {
      preHandler: [
        verifyAgentRequest(deps.db),
        rateLimit(deps.db, "message_send_per_agent", (req) => req.agent!.doc._id),
        rateLimit(
          deps.db,
          "message_send_per_session",
          (req) => `${req.agent!.doc._id}:${(req.params as { attestationId: string }).attestationId}`,
        ),
      ],
    },
    async (req, reply) => {
      const body = parseOrError(AppendEventBody, req.body, reply);
      if (!body) return;
      const result = await appendAttestationEvent(deps, req.agent!.doc, req.params.attestationId, body);
      if (!result.ok) return sendError(reply, result.error.status, result.error.code, result.error.message, result.error.details);
      return reply.code(201).send({ event: messageView(result.event), head: result.head });
    },
  );

  app.get<{ Params: { attestationId: string } }>(
    "/v1/attestations/:attestationId/events",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const attestation = await attestations.findById(req.params.attestationId);
      if (!attestation || !canAccessAttestation(attestation, req)) return sendError(reply, 404, "not_found", "Attestation not found");
      const q = req.query as { afterSeq?: string; limit?: string };
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const afterSeq = Math.max(Number(q.afterSeq) || 0, 0);
      const items = await findMessagesBySession(deps.db, attestation._id, { afterSeq, limit });
      return { items: items.map(messageView), nextCursor: items.length === limit ? items[items.length - 1]!.seq : null };
    },
  );

  app.post<{ Params: { attestationId: string } }>(
    "/v1/attestations/:attestationId/close",
    { preHandler: [verifyAgentRequest(deps.db), rateLimit(deps.db, "session_close", (req) => req.agent!.doc._id)] },
    async (req, reply) => {
      const body = parseOrError(CloseAttestationBody, req.body, reply);
      if (!body) return;

      const attestation = await attestations.findById(req.params.attestationId);
      if (!attestation || attestation.attestor.agentId !== req.agent!.doc._id) {
        return sendError(reply, 404, "not_found", "Attestation not found");
      }
      if (attestation.status !== "active") return sendError(reply, 409, "attestation_not_active", "Attestation is not active");

      const { statement, signature } = body;
      if (
        statement.sessionId !== attestation._id ||
        statement.headSeq !== attestation.head.seq ||
        statement.headHash !== attestation.head.hash
      ) {
        return sendError(reply, 422, "head_mismatch", "close statement does not match the current head");
      }
      const key = req.agent!.doc.keys.find((k) => k.kid === attestation.attestor.kid);
      const verified =
        !!key &&
        verifySignature(
          { alg: "Ed25519", kid: key.kid, publicKey: base64UrlDecode(key.publicKey) },
          "close",
          sha256(canonicalizeToBytes(statement)),
          signature,
        );
      if (!verified) return sendError(reply, 422, "invalid_signature", "close signature does not verify");

      const updated = await attestations.update(attestation._id, {
        status: "closing",
        closing: { reason: "agent_closed", requestedBy: req.agent!.doc._id, statement, signature, requestedAt: new Date() },
      });
      return reply.code(202).send({ attestation: attestationView(updated!) });
    },
  );
}
