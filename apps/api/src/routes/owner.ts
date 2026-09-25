import {
  agentsRepository,
  invitesRepository,
  listRecordsForAgents,
  listRecordsForOwner,
  newId,
  ownersRepository,
  sessionsRepository,
  viewerGrantsRepository,
  type ViewerGrantDoc,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentFullView, agentPublicView } from "../domain/agentViews.js";
import { computeGenesisHash } from "../domain/genesis.js";
import { inviteView, sessionView } from "../domain/sessionViews.js";
import { parseOrError, sendError } from "../errors.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { verifyOwnerSession } from "../plugins/ownerAuth.js";
import type { ServerDeps } from "../server.js";

const PatchOwnerBody = z.strictObject({
  displayName: z.string().max(100).nullable().optional(),
  settings: z.strictObject({ requireInviteApproval: z.boolean().optional(), emailOnRecord: z.boolean().optional() }).optional(),
});

const InviteViewerBody = z.strictObject({
  email: z.string().email().max(254),
  label: z.string().max(100).nullable().optional(),
});

function paginationOf(query: unknown): { limit: number; cursor?: string } {
  const q = query as { limit?: string; cursor?: string };
  return { limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200), cursor: q.cursor };
}

function ownerView(doc: { _id: string; email: string; displayName: string | null; settings: unknown; createdAt: Date }) {
  return { id: doc._id, email: doc.email, displayName: doc.displayName, settings: doc.settings, createdAt: doc.createdAt.toISOString() };
}

function recordView(doc: { _id: string; sessionId: string; statement: unknown; statementHash: string; evidence: { sha256: string; bytes: number }; createdAt: Date }) {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    statement: doc.statement,
    statementHash: doc.statementHash,
    evidence: { sha256: doc.evidence.sha256, bytes: doc.evidence.bytes },
    createdAt: doc.createdAt.toISOString(),
  };
}

function viewerGrantView(doc: ViewerGrantDoc) {
  return {
    id: doc._id,
    ownerId: doc.ownerId,
    agentId: doc.agentId,
    viewerEmail: doc.viewerEmail,
    label: doc.label,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    revokedAt: doc.revokedAt?.toISOString() ?? null,
  };
}

export function registerOwnerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const agents = agentsRepository(deps.db);
  const sessions = sessionsRepository(deps.db);
  const invites = invitesRepository(deps.db);
  const owners = ownersRepository(deps.db);
  const viewerGrants = viewerGrantsRepository(deps.db);
  const ownerAuth = verifyOwnerSession(deps.db, { webOrigin: deps.webOrigin });

  app.get("/v1/owner/me", { preHandler: ownerAuth }, async (req) => ({ owner: ownerView(req.owner!) }));

  app.patch("/v1/owner/me", { preHandler: ownerAuth }, async (req, reply) => {
    const body = parseOrError(PatchOwnerBody, req.body, reply);
    if (!body) return;
    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.settings) patch.settings = { ...req.owner!.settings, ...body.settings };
    const updated = await owners.update(req.owner!._id, patch);
    return { owner: ownerView(updated!) };
  });

  app.get("/v1/owner/agents", { preHandler: ownerAuth }, async (req) => {
    const items = await agents.listByOwner(req.owner!._id, paginationOf(req.query));
    return { items: items.map(agentFullView), nextCursor: null };
  });

  app.get("/v1/owner/sessions", { preHandler: ownerAuth }, async (req) => {
    const { limit, cursor } = paginationOf(req.query);
    const filter: Record<string, unknown> = {
      $or: [{ "initiator.ownerId": req.owner!._id }, { "counterparty.ownerId": req.owner!._id }],
    };
    if (cursor) filter._id = { $lt: cursor };
    const items = await sessions.collection.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
    return { items: items.map(sessionView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  app.get("/v1/owner/invites", { preHandler: ownerAuth }, async (req) => {
    const { limit } = paginationOf(req.query);
    const pendingSessions = await sessions.collection
      .find({ "counterparty.ownerId": req.owner!._id, status: "pending" })
      .sort({ createdAt: -1 })
      .toArray();
    const candidates = await Promise.all(pendingSessions.map((s) => invites.findById(s.inviteId)));
    const items = candidates.filter((i) => i && i.status === "awaiting_owner").slice(0, limit);
    return { items: items.map((i) => inviteView(i!)), nextCursor: null };
  });

  app.post<{ Params: { agentId: string } }>("/v1/owner/agents/:agentId/suspend", { preHandler: ownerAuth }, async (req, reply) => {
    const agent = await agents.findById(req.params.agentId);
    if (!agent || agent.ownerId !== req.owner!._id) return sendError(reply, 404, "not_found", "Agent not found");
    const updated = await agents.update(agent._id, { status: "suspended", suspendedAt: new Date() });

    const affected = await sessions.findActiveOrPendingByAgent(agent._id);
    for (const s of affected) {
      if (s.status === "active") {
        await sessions.update(s._id, {
          status: "closing",
          closing: { reason: "agent_suspended", requestedBy: null, statement: null, signature: null, requestedAt: new Date() },
        });
      } else if (s.status === "pending") {
        await sessions.update(s._id, { status: "cancelled" });
        await invites.update(s.inviteId, { status: "cancelled", respondedAt: new Date() });
      }
    }
    return { agent: agentFullView(updated!) };
  });

  app.post<{ Params: { agentId: string } }>("/v1/owner/agents/:agentId/unsuspend", { preHandler: ownerAuth }, async (req, reply) => {
    const agent = await agents.findById(req.params.agentId);
    if (!agent || agent.ownerId !== req.owner!._id) return sendError(reply, 404, "not_found", "Agent not found");
    const updated = await agents.update(agent._id, { status: "active", suspendedAt: null });
    return { agent: agentFullView(updated!) };
  });

  app.post<{ Params: { inviteId: string } }>("/v1/owner/invites/:inviteId/approve", { preHandler: ownerAuth }, async (req, reply) => {
    const invite = await invites.findById(req.params.inviteId);
    if (!invite || invite.status !== "awaiting_owner") return sendError(reply, 409, "invite_not_pending", "Invite is not awaiting approval");
    const session = await sessions.findById(invite.sessionId);
    if (!session || session.counterparty.ownerId !== req.owner!._id) return sendError(reply, 404, "not_found", "Invite not found");
    if (!session.accept || !session.acceptSignature) return sendError(reply, 409, "invite_not_pending", "Session has no pending accept");

    const { genesisHashBytes, genesisHash } = computeGenesisHash(session.offer, session.offerSignature, session.accept, session.acceptSignature);
    const genesisSignature = await deps.signer.sign("genesis", genesisHashBytes);
    const now = new Date();
    const updatedSession = await sessions.update(session._id, {
      genesisHash,
      genesisSignature,
      status: "active",
      activatedAt: now,
      lastActivityAt: now,
    });
    const updatedInvite = await invites.update(invite._id, {
      status: "accepted",
      respondedAt: now,
      ownerApproval: { required: true, decision: "approved", decidedBy: req.owner!._id, decidedAt: now },
    });
    return { invite: inviteView(updatedInvite!), session: sessionView(updatedSession!) };
  });

  app.post<{ Params: { inviteId: string } }>("/v1/owner/invites/:inviteId/reject", { preHandler: ownerAuth }, async (req, reply) => {
    const invite = await invites.findById(req.params.inviteId);
    if (!invite || invite.status !== "awaiting_owner") return sendError(reply, 409, "invite_not_pending", "Invite is not awaiting approval");
    const session = await sessions.findById(invite.sessionId);
    if (!session || session.counterparty.ownerId !== req.owner!._id) return sendError(reply, 404, "not_found", "Invite not found");

    const now = new Date();
    const updatedInvite = await invites.update(invite._id, {
      status: "rejected_by_owner",
      respondedAt: now,
      ownerApproval: { required: true, decision: "rejected", decidedBy: req.owner!._id, decidedAt: now },
    });
    const updatedSession = await sessions.update(session._id, { status: "declined" });
    return { invite: inviteView(updatedInvite!), session: sessionView(updatedSession!) };
  });

  app.get("/v1/owner/records", { preHandler: ownerAuth }, async (req) => {
    const { limit, cursor } = paginationOf(req.query);
    const items = await listRecordsForOwner(deps.db, req.owner!._id, { limit, cursor });
    return { items: items.map(recordView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  // -------------------------------------------------------------- viewer access (Prompt 6)
  // Granting side: an owner invites a human — legal, a manager, an auditor — to read-only
  // access on one of their agents. Receiving side: that human (identified the same way any
  // owner is, by verified email — see plugins/ownerAuth.ts) lists what they've been given.

  app.post<{ Params: { agentId: string } }>(
    "/v1/owner/agents/:agentId/viewers",
    { preHandler: [ownerAuth, rateLimit(deps.db, "viewer_invite", (req) => req.owner!._id)] },
    async (req, reply) => {
      const agent = await agents.findById(req.params.agentId);
      if (!agent || agent.ownerId !== req.owner!._id) return sendError(reply, 404, "not_found", "Agent not found");

      const body = parseOrError(InviteViewerBody, req.body, reply);
      if (!body) return;
      const viewerEmail = body.email.toLowerCase();

      const existing = await viewerGrants.findByAgentAndEmail(agent._id, viewerEmail);
      if (existing) {
        if (existing.status === "active") return sendError(reply, 409, "viewer_exists", "This email already has viewer access to this agent");
        const reactivated = await viewerGrants.update(existing._id, { status: "active", revokedAt: null, label: body.label ?? existing.label });
        await deps.mailer
          .sendViewerInvite(viewerEmail, agent.name, `${deps.webOrigin}/login?redirectTo=/dashboard`)
          .catch((err) => req.log.error({ err }, "failed to send viewer invite email"));
        return reply.code(201).send({ grant: viewerGrantView(reactivated!) });
      }

      const now = new Date();
      const doc = await viewerGrants.insert({
        _id: newId("vwg"),
        ownerId: req.owner!._id,
        agentId: agent._id,
        viewerEmail,
        label: body.label ?? null,
        status: "active",
        createdAt: now,
        revokedAt: null,
      });
      await deps.mailer
        .sendViewerInvite(viewerEmail, agent.name, `${deps.webOrigin}/login?redirectTo=/dashboard`)
        .catch((err) => req.log.error({ err }, "failed to send viewer invite email"));
      return reply.code(201).send({ grant: viewerGrantView(doc) });
    },
  );

  app.get<{ Params: { agentId: string } }>("/v1/owner/agents/:agentId/viewers", { preHandler: ownerAuth }, async (req, reply) => {
    const agent = await agents.findById(req.params.agentId);
    if (!agent || agent.ownerId !== req.owner!._id) return sendError(reply, 404, "not_found", "Agent not found");
    const { limit, cursor } = paginationOf(req.query);
    const items = await viewerGrants.listForAgent(agent._id, { limit, cursor });
    return { items: items.map(viewerGrantView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  app.post<{ Params: { agentId: string; grantId: string } }>(
    "/v1/owner/agents/:agentId/viewers/:grantId/revoke",
    { preHandler: ownerAuth },
    async (req, reply) => {
      const agent = await agents.findById(req.params.agentId);
      if (!agent || agent.ownerId !== req.owner!._id) return sendError(reply, 404, "not_found", "Agent not found");
      const grant = await viewerGrants.findById(req.params.grantId);
      if (!grant || grant.agentId !== agent._id) return sendError(reply, 404, "not_found", "Viewer grant not found");
      if (grant.status === "revoked") return { grant: viewerGrantView(grant) };
      const updated = await viewerGrants.update(grant._id, { status: "revoked", revokedAt: new Date() });
      return { grant: viewerGrantView(updated!) };
    },
  );

  app.get("/v1/owner/viewer-access", { preHandler: ownerAuth }, async (req) => {
    const grants = await viewerGrants.listActiveForViewer(req.owner!.email);
    const agentDocs = await Promise.all(grants.map((g) => agents.findById(g.agentId)));
    const items = grants.map((g, i) => ({ grant: viewerGrantView(g), agent: agentDocs[i] ? agentPublicView(agentDocs[i]!) : null }));
    return { items };
  });

  app.get("/v1/owner/viewer-access/sessions", { preHandler: ownerAuth }, async (req) => {
    const { limit, cursor } = paginationOf(req.query);
    const agentIds = [...(req.viewerAgentIds ?? [])];
    const filter: Record<string, unknown> = {
      $or: [{ "initiator.agentId": { $in: agentIds } }, { "counterparty.agentId": { $in: agentIds } }],
    };
    if (cursor) filter._id = { $lt: cursor };
    const items = await sessions.collection.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
    return { items: items.map(sessionView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  app.get("/v1/owner/viewer-access/records", { preHandler: ownerAuth }, async (req) => {
    const { limit, cursor } = paginationOf(req.query);
    const items = await listRecordsForAgents(deps.db, [...(req.viewerAgentIds ?? [])], { limit, cursor });
    return { items: items.map(recordView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });
}
