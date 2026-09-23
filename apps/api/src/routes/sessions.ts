import {
  Offer,
  Signature,
  agentsRepository,
  base64UrlDecode,
  canonicalizeToBytes,
  invitesRepository,
  newId,
  sessionsRepository,
  sha256,
  verifySignature,
  type InviteDoc,
  type SessionDoc,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessSession } from "../domain/access.js";
import { withinClockSkew } from "../domain/genesis.js";
import { inviteView, sessionView } from "../domain/sessionViews.js";
import { generateToken, hashToken } from "../domain/tokens.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { requireClaimed } from "../plugins/requireClaimed.js";
import type { ServerDeps } from "../server.js";

const MIN_EXPIRY_MS = 5 * 60_000;
const MAX_EXPIRY_MS = 7 * 24 * 3_600_000;
const MAX_PENDING_SESSIONS = 20;

const CreateSessionBody = z.strictObject({ offer: Offer, offerSignature: Signature });

export function registerSessionsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const sessions = sessionsRepository(deps.db);
  const invites = invitesRepository(deps.db);
  const agents = agentsRepository(deps.db);

  app.post(
    "/v1/sessions",
    {
      preHandler: [
        verifyAgentRequest(deps.db),
        requireClaimed,
        rateLimit(deps.db, "session_create", (req) => req.agent!.doc._id),
      ],
    },
    async (req, reply) => {
      const body = parseOrError(CreateSessionBody, req.body, reply);
      if (!body) return;
      const { offer, offerSignature } = body;
      const initiator = req.agent!.doc;

      if (offer.initiator.agentId !== initiator._id) {
        return sendError(reply, 422, "offer_invalid", "offer.initiator.agentId must be the authenticated agent");
      }
      const initiatorKey = initiator.keys.find((k) => k.kid === offer.initiator.kid);
      if (!initiatorKey || initiatorKey.revokedAt || initiatorKey.publicKey !== offer.initiator.publicKey) {
        return sendError(reply, 422, "offer_invalid", "offer.initiator kid/publicKey must match an unrevoked key");
      }
      const offerVerified = verifySignature(
        { alg: "Ed25519", kid: initiatorKey.kid, publicKey: base64UrlDecode(initiatorKey.publicKey) },
        "offer",
        sha256(canonicalizeToBytes(offer)),
        offerSignature,
      );
      if (!offerVerified) return sendError(reply, 422, "offer_invalid", "offerSignature does not verify");
      if (!withinClockSkew(offer.createdAt)) {
        return sendError(reply, 422, "offer_invalid", "offer.createdAt is outside the allowed ±300s window");
      }
      const durationMs = Date.parse(offer.expiresAt) - Date.parse(offer.createdAt);
      if (!(durationMs >= MIN_EXPIRY_MS && durationMs <= MAX_EXPIRY_MS)) {
        return sendError(reply, 422, "offer_invalid", "expiresAt - createdAt must be between 5 minutes and 7 days");
      }
      if (await sessions.findById(offer.sessionId)) {
        return sendError(reply, 409, "session_id_taken", "This sessionId is already in use");
      }

      let counterpartyAgent = null;
      if (offer.counterparty) {
        if (offer.counterparty.agentId === initiator._id) {
          return sendError(reply, 422, "offer_invalid", "An agent cannot open a session with itself");
        }
        counterpartyAgent = await agents.findById(offer.counterparty.agentId);
        if (!counterpartyAgent || counterpartyAgent.status !== "active") {
          return sendError(reply, 404, "not_found", "Counterparty agent not found or not active");
        }
      }

      const pendingCount = await sessions.countPendingByInitiator(initiator._id);
      if (pendingCount >= MAX_PENDING_SESSIONS) {
        return sendError(reply, 409, "too_many_pending", "Too many pending sessions for this initiator");
      }

      const now = new Date();
      const inviteId = newId("inv");
      const sessionDoc: SessionDoc = {
        _id: offer.sessionId,
        mode: offer.mode,
        status: "pending",
        purpose: offer.purpose,
        initiator: { agentId: initiator._id, ownerId: initiator.ownerId, kid: initiatorKey.kid },
        counterparty: { agentId: offer.counterparty?.agentId ?? null, ownerId: counterpartyAgent?.ownerId ?? null, kid: null },
        inviteId,
        offer,
        offerSignature,
        accept: null,
        acceptSignature: null,
        genesisHash: null,
        genesisSignature: null,
        head: { seq: 0, hash: null },
        messageCount: 0,
        idleTimeoutSec: offer.idleTimeoutSec,
        createdAt: now,
        activatedAt: null,
        lastActivityAt: now,
        expiresAt: new Date(offer.expiresAt),
        closing: null,
        closedAt: null,
        recordId: null,
      };
      await sessions.insert(sessionDoc);

      const kind = offer.counterparty ? "direct" : "open";
      let token: string | undefined;
      let tokenHash: string | null = null;
      if (kind === "open") {
        token = generateToken(24);
        tokenHash = hashToken(token);
      }
      const inviteDoc: InviteDoc = {
        _id: inviteId,
        sessionId: offer.sessionId,
        fromAgentId: initiator._id,
        kind,
        toAgentId: offer.counterparty?.agentId ?? null,
        tokenHash,
        status: "pending",
        ownerApproval: null,
        expiresAt: new Date(offer.expiresAt),
        createdAt: now,
        respondedAt: null,
      };
      await invites.insert(inviteDoc);

      return reply.code(201).send({
        session: sessionView(sessionDoc),
        invite: {
          ...inviteView(inviteDoc),
          token: token ?? null,
          url: token ? `${deps.publicUrl}/invites/${inviteId}?token=${token}` : null,
        },
      });
    },
  );

  app.get("/v1/sessions", { preHandler: verifyAgentRequest(deps.db) }, async (req) => {
    const q = req.query as { status?: string; cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const filter: Record<string, unknown> = {
      $or: [{ "initiator.agentId": req.agent!.doc._id }, { "counterparty.agentId": req.agent!.doc._id }],
    };
    if (q.status) filter.status = q.status;
    if (q.cursor) filter._id = { $lt: q.cursor };
    const items = await sessions.collection.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
    return { items: items.map(sessionView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const session = await sessions.findById(req.params.sessionId);
      if (!session || !canAccessSession(session, req)) return sendError(reply, 404, "not_found", "Session not found");
      return { session: sessionView(session) };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/cancel",
    { preHandler: verifyAgentRequest(deps.db) },
    async (req, reply) => {
      const session = await sessions.findById(req.params.sessionId);
      if (!session || session.initiator.agentId !== req.agent!.doc._id) {
        return sendError(reply, 404, "not_found", "Session not found");
      }
      if (session.status !== "pending") return sendError(reply, 409, "session_not_pending", "Session is not pending");
      const updated = await sessions.update(session._id, { status: "cancelled" });
      await invites.update(session.inviteId, { status: "cancelled", respondedAt: new Date() });
      return { session: sessionView(updated!) };
    },
  );
}
