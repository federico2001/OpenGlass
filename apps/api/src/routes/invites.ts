import {
  Accept,
  Signature,
  agentsRepository,
  base64UrlDecode,
  canonicalizeToBytes,
  hex,
  invitesRepository,
  ownersRepository,
  sessionsRepository,
  sha256,
  verifySignature,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentPublicView } from "../domain/agentViews.js";
import { computeGenesisHash, withinClockSkew } from "../domain/genesis.js";
import { inviteView, sessionView } from "../domain/sessionViews.js";
import { hashToken } from "../domain/tokens.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { requireClaimed } from "../plugins/requireClaimed.js";
import type { ServerDeps } from "../server.js";

const AcceptBody = z.strictObject({ token: z.string().optional(), accept: Accept, signature: Signature });
const DeclineBody = z.strictObject({ token: z.string().optional(), reason: z.string().max(500).optional() });

export function registerInvitesRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const invites = invitesRepository(deps.db);
  const sessions = sessionsRepository(deps.db);
  const agents = agentsRepository(deps.db);
  const owners = ownersRepository(deps.db);

  app.get("/v1/invites", { preHandler: verifyAgentRequest(deps.db) }, async (req) => {
    const q = req.query as { status?: string; cursor?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const items = await invites.listForAgent(req.agent!.doc._id, {
      limit,
      cursor: q.cursor,
      status: q.status as never,
    });
    return { items: items.map(inviteView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  app.get<{ Params: { inviteId: string }; Querystring: { token?: string } }>(
    "/v1/invites/:inviteId",
    { preHandler: verifyAgentRequest(deps.db) },
    async (req, reply) => {
      const invite = await invites.findById(req.params.inviteId);
      if (!invite) return sendError(reply, 404, "not_found", "Invite not found");
      const caller = req.agent!.doc._id;

      if (invite.kind === "direct") {
        if (invite.toAgentId !== caller && invite.fromAgentId !== caller) return sendError(reply, 404, "not_found", "Invite not found");
      } else {
        const tokenOk = !!req.query.token && invite.tokenHash === hashToken(req.query.token);
        if (invite.fromAgentId !== caller && !tokenOk) return sendError(reply, 404, "not_found", "Invite not found");
      }

      const session = await sessions.findById(invite.sessionId);
      // The initiator side is always set at session-creation time (only counterparty
      // can be null, before an open invite is accepted).
      if (!session || !session.initiator.agentId) return sendError(reply, 404, "not_found", "Invite not found");
      const initiatorAgent = await agents.findById(session.initiator.agentId);
      if (!initiatorAgent) return sendError(reply, 404, "not_found", "Invite not found");

      return {
        invite: inviteView(invite),
        offer: session.offer,
        offerSignature: session.offerSignature,
        offerHash: hex(sha256(canonicalizeToBytes(session.offer))),
        initiator: agentPublicView(initiatorAgent),
      };
    },
  );

  app.post<{ Params: { inviteId: string } }>(
    "/v1/invites/:inviteId/accept",
    {
      preHandler: [
        verifyAgentRequest(deps.db),
        requireClaimed,
        rateLimit(deps.db, "invite_respond", (req) => req.agent!.doc._id),
      ],
    },
    async (req, reply) => {
      const body = parseOrError(AcceptBody, req.body, reply);
      if (!body) return;

      const invite = await invites.findById(req.params.inviteId);
      if (!invite) return sendError(reply, 404, "not_found", "Invite not found");
      if (invite.status !== "pending") return sendError(reply, 409, "invite_not_pending", "Invite is not pending");
      if (invite.expiresAt.getTime() < Date.now()) return sendError(reply, 410, "invite_expired", "Invite has expired");

      const acceptingAgent = req.agent!.doc;
      if (invite.kind === "direct") {
        if (invite.toAgentId !== acceptingAgent._id) return sendError(reply, 404, "not_found", "Invite not found");
      } else {
        if (!body.token || invite.tokenHash !== hashToken(body.token)) return sendError(reply, 404, "not_found", "Invite not found");
        if (invite.fromAgentId === acceptingAgent._id) {
          return sendError(reply, 422, "accept_invalid", "Cannot accept your own open invite");
        }
      }

      const session = await sessions.findById(invite.sessionId);
      if (!session) return sendError(reply, 404, "not_found", "Invite not found");

      const { accept, signature } = body;
      const offerHash = hex(sha256(canonicalizeToBytes(session.offer)));
      if (accept.offerHash !== offerHash) return sendError(reply, 422, "accept_invalid", "accept.offerHash does not match the offer");
      if (accept.sessionId !== session._id) return sendError(reply, 422, "accept_invalid", "accept.sessionId mismatch");
      if (accept.counterparty.agentId !== acceptingAgent._id) {
        return sendError(reply, 422, "accept_invalid", "accept.counterparty must be the authenticated agent");
      }
      const key = acceptingAgent.keys.find((k) => k.kid === accept.counterparty.kid);
      if (!key || key.revokedAt || key.publicKey !== accept.counterparty.publicKey) {
        return sendError(reply, 422, "accept_invalid", "accept.counterparty kid/publicKey must match an unrevoked key");
      }
      if (!withinClockSkew(accept.acceptedAt)) {
        return sendError(reply, 422, "accept_invalid", "accept.acceptedAt is outside the allowed ±300s window");
      }
      const acceptVerified = verifySignature(
        { alg: "Ed25519", kid: key.kid, publicKey: base64UrlDecode(key.publicKey) },
        "accept",
        sha256(canonicalizeToBytes(accept)),
        signature,
      );
      if (!acceptVerified) return sendError(reply, 422, "accept_invalid", "acceptSignature does not verify");

      const ownerDoc = acceptingAgent.ownerId ? await owners.findById(acceptingAgent.ownerId) : null;
      const requiresApproval = ownerDoc?.settings.requireInviteApproval ?? false;
      const now = new Date();
      const counterparty = { agentId: acceptingAgent._id, ownerId: acceptingAgent.ownerId, kid: key.kid };

      if (requiresApproval) {
        await sessions.update(session._id, { accept, acceptSignature: signature, counterparty });
        const updatedInvite = await invites.update(invite._id, {
          status: "awaiting_owner",
          ownerApproval: { required: true, decision: null, decidedBy: null, decidedAt: null },
        });
        const updatedSession = await sessions.findById(session._id);
        return reply.code(202).send({ invite: inviteView(updatedInvite!), session: sessionView(updatedSession!) });
      }

      const { genesisHashBytes, genesisHash } = computeGenesisHash(session.offer, session.offerSignature, accept, signature);
      const genesisSignature = await deps.signer.sign("genesis", genesisHashBytes);
      const updatedSession = await sessions.update(session._id, {
        accept,
        acceptSignature: signature,
        counterparty,
        genesisHash,
        genesisSignature,
        status: "active",
        activatedAt: now,
        lastActivityAt: now,
      });
      const updatedInvite = await invites.update(invite._id, { status: "accepted", respondedAt: now });
      return reply.send({ invite: inviteView(updatedInvite!), session: sessionView(updatedSession!) });
    },
  );

  app.post<{ Params: { inviteId: string } }>(
    "/v1/invites/:inviteId/decline",
    { preHandler: verifyAgentRequest(deps.db) },
    async (req, reply) => {
      const body = parseOrError(DeclineBody, req.body ?? {}, reply);
      if (!body) return;

      const invite = await invites.findById(req.params.inviteId);
      if (!invite) return sendError(reply, 404, "not_found", "Invite not found");
      if (invite.status !== "pending" && invite.status !== "awaiting_owner") {
        return sendError(reply, 409, "invite_not_pending", "Invite is not pending");
      }

      const caller = req.agent!.doc._id;
      if (invite.kind === "direct") {
        if (invite.toAgentId !== caller) return sendError(reply, 404, "not_found", "Invite not found");
      } else if (!body.token || invite.tokenHash !== hashToken(body.token)) {
        return sendError(reply, 404, "not_found", "Invite not found");
      }

      const now = new Date();
      const updatedInvite = await invites.update(invite._id, { status: "declined", respondedAt: now });
      const updatedSession = await sessions.update(invite.sessionId, { status: "declined" });
      return { invite: inviteView(updatedInvite!), session: sessionView(updatedSession!) };
    },
  );
}
