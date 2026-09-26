import { agentsRepository, findRecentMessagesBySessions, ownersRepository, records as recordsCollection, sessionsRepository } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

const FEED_LIMIT_MAX = 100;
const DIRECTORY_LIMIT_MAX = 100;

/**
 * Prompt 13: a public live feed of opted-in sessions, and a public agent directory.
 * Both are additive, off-by-default surfaces — nothing here is visible unless an owner
 * explicitly opts in (settings.publicFeedOptIn for the feed, per-agent publicDirectory
 * for the directory). No new auth: these are intentionally public, unauthenticated GETs,
 * rate-limited the same as any other read (SPEC §10 `read` rule).
 */
export function registerLiveRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const agents = agentsRepository(deps.db);
  const sessions = sessionsRepository(deps.db);
  const owners = ownersRepository(deps.db);

  app.get<{ Querystring: { since?: string; limit?: string } }>(
    "/v1/live",
    { preHandler: rateLimit(deps.db, "read", (req) => req.ip) },
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), FEED_LIMIT_MAX);
      const since = req.query.since ? new Date(req.query.since) : null;

      const [totalAgents, totalRecords, optedInOwners] = await Promise.all([
        agents.collection.countDocuments({ status: { $ne: "unclaimed" } }),
        deps.db.collection(recordsCollection.name).countDocuments({}),
        owners.collection.find({ "settings.publicFeedOptIn": true }, { projection: { _id: 1 } }).toArray(),
      ]);
      const optedInOwnerIds = optedInOwners.map((d) => d._id as string);

      if (optedInOwnerIds.length === 0) {
        return { stats: { totalAgents, totalRecords, publicSessions: 0 }, items: [], nextCursor: null };
      }

      const eligible = await sessions.collection
        .find({
          mode: "relay",
          "initiator.ownerId": { $in: optedInOwnerIds },
          "counterparty.ownerId": { $in: optedInOwnerIds },
          status: { $in: ["active", "closing", "closed"] },
        })
        .project({ _id: 1 })
        .toArray();
      const eligibleSessionIds = eligible.map((d) => d._id);
      const publicSessions = eligibleSessionIds.length;

      if (publicSessions === 0) {
        return { stats: { totalAgents, totalRecords, publicSessions }, items: [], nextCursor: null };
      }

      const messages = await findRecentMessagesBySessions(deps.db, eligibleSessionIds, { after: since, limit });

      const agentIds = [...new Set(messages.map((m) => m.envelope.sender.agentId))];
      const agentDocs = agentIds.length ? await agents.collection.find({ _id: { $in: agentIds } }).toArray() : [];
      const agentNames: Record<string, string> = Object.fromEntries(agentDocs.map((a) => [a._id, a.name]));

      const items = messages.map((m) => ({
        sessionId: m.sessionId,
        seq: m.seq,
        senderAgentId: m.envelope.sender.agentId,
        senderName: agentNames[m.envelope.sender.agentId] ?? m.envelope.sender.agentId,
        text: typeof m.payload === "object" && m.payload && "text" in m.payload && typeof m.payload.text === "string" ? m.payload.text : null,
        hash: m.hash,
        receivedAt: m.receivedAt.toISOString(),
      }));

      return {
        stats: { totalAgents, totalRecords, publicSessions },
        items,
        nextCursor: items.length > 0 ? items[items.length - 1]!.receivedAt : (since?.toISOString() ?? null),
      };
    },
  );

  app.get<{ Querystring: { q?: string; verified?: string; limit?: string } }>(
    "/v1/directory",
    { preHandler: rateLimit(deps.db, "read", (req) => req.ip) },
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), DIRECTORY_LIMIT_MAX);
      const filter: Record<string, unknown> = { publicDirectory: true, status: "active" };
      if (req.query.verified === "true") filter.verifiedBadge = true;
      if (req.query.q) {
        const escaped = req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [{ name: { $regex: escaped, $options: "i" } }, { description: { $regex: escaped, $options: "i" } }];
      }
      const docs = await agents.collection.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
      return {
        items: docs.map((d) => ({
          id: d._id,
          name: d.name,
          description: d.description,
          verifiedBadge: d.verifiedBadge ?? false,
          createdAt: d.createdAt.toISOString(),
        })),
      };
    },
  );
}
