import {
  DUPLICATE_KEY_ERROR_CODE,
  integrationRequestsRepository,
  integrationStatusRepository,
  integrationVotesRepository,
  newId,
  ownersRepository,
  webSessionsRepository,
  type IntegrationRequestDoc,
} from "@openglass/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MongoServerError } from "mongodb";
import { z } from "zod";
import { loadIntegrationsCatalog } from "../domain/integrationsCatalog.js";
import { hashToken } from "../domain/tokens.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAdminSession } from "../plugins/adminAuth.js";
import { SESSION_COOKIE_NAME, verifyOwnerSession } from "../plugins/ownerAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

const RequestBody = z.strictObject({
  frameworkName: z.string().min(1).max(200),
  frameworkUrl: z.string().max(500).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

const StatusBody = z.strictObject({
  status: z.enum(["requested", "in_progress", "available", "native"]),
});

function requestView(doc: IntegrationRequestDoc) {
  return {
    id: doc._id,
    frameworkName: doc.frameworkName,
    frameworkUrl: doc.frameworkUrl,
    note: doc.note,
    requesterEmail: doc.requesterEmail,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
  };
}

function paginationOf(query: unknown): { limit: number; cursor?: string } {
  const q = query as { limit?: string; cursor?: string };
  return { limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200), cursor: q.cursor };
}

export function registerIntegrationsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const votes = integrationVotesRepository(deps.db);
  const statusOverrides = integrationStatusRepository(deps.db);
  const requests = integrationRequestsRepository(deps.db);
  const owners = ownersRepository(deps.db);
  const webSessions = webSessionsRepository(deps.db);
  const ownerAuth = verifyOwnerSession(deps.db, { webOrigin: deps.webOrigin });
  const adminAuth = verifyAdminSession(deps.db, { webOrigin: deps.webOrigin, adminEmails: deps.adminEmails });

  /** Reads the og_session cookie if present, without requiring it — the catalog itself is
   * public, but a signed-in visitor also gets to see which cards they've already voted
   * for. An expired/invalid cookie is treated the same as no cookie at all: still public. */
  async function tryLoadOwnerId(req: FastifyRequest): Promise<string | undefined> {
    const token = req.cookies[SESSION_COOKIE_NAME];
    if (!token) return undefined;
    const session = await webSessions.findByTokenHash(hashToken(token));
    if (!session || session.expiresAt.getTime() < Date.now()) return undefined;
    const owner = await owners.findById(session.ownerId);
    return owner && owner.status === "active" ? owner._id : undefined;
  }

  app.get("/v1/integrations", async (req) => {
    const catalog = loadIntegrationsCatalog();
    const slugs = catalog.map((f) => f.slug);
    const [overrides, counts, ownerId] = await Promise.all([
      statusOverrides.findAll(),
      votes.countsBySlug(slugs),
      tryLoadOwnerId(req),
    ]);
    const overrideBySlug = new Map(overrides.map((o) => [o._id, o.status]));
    const votedSlugs = ownerId ? await votes.votedSlugsForOwner(ownerId) : new Set<string>();

    return {
      items: catalog.map((f) => ({
        slug: f.slug,
        name: f.name,
        url: f.url,
        description: f.description,
        category: f.category,
        evidence: f.evidence,
        status: overrideBySlug.get(f.slug) ?? f.defaultStatus,
        voteCount: counts[f.slug] ?? 0,
        hasVoted: votedSlugs.has(f.slug),
      })),
    };
  });

  app.post<{ Params: { slug: string } }>(
    "/v1/integrations/:slug/vote",
    { preHandler: [ownerAuth, rateLimit(deps.db, "integration_vote", (req) => req.owner!._id)] },
    async (req, reply) => {
      const catalog = loadIntegrationsCatalog();
      if (!catalog.some((f) => f.slug === req.params.slug)) return sendError(reply, 404, "not_found", "Unknown integration slug");

      if (await votes.findBySlugAndOwner(req.params.slug, req.owner!._id)) {
        return sendError(reply, 409, "already_voted", "You've already voted for this framework");
      }
      try {
        await votes.insert({ _id: newId("ivt"), slug: req.params.slug, ownerId: req.owner!._id, createdAt: new Date() });
      } catch (err) {
        // Defense in depth for the race between the check above and this insert — the
        // unique index (slug_owner_unique) is what actually closes it in production,
        // where migrate() has run; route tests build the server without migrating.
        if ((err as MongoServerError).code !== DUPLICATE_KEY_ERROR_CODE) throw err;
        return sendError(reply, 409, "already_voted", "You've already voted for this framework");
      }
      const counts = await votes.countsBySlug([req.params.slug]);
      return reply.code(201).send({ slug: req.params.slug, voteCount: counts[req.params.slug] ?? 0 });
    },
  );

  app.delete<{ Params: { slug: string } }>("/v1/integrations/:slug/vote", { preHandler: ownerAuth }, async (req) => {
    await votes.deleteBySlugAndOwner(req.params.slug, req.owner!._id);
    const counts = await votes.countsBySlug([req.params.slug]);
    return { slug: req.params.slug, voteCount: counts[req.params.slug] ?? 0 };
  });

  app.post(
    "/v1/integrations/requests",
    { preHandler: [ownerAuth, rateLimit(deps.db, "integration_request", (req) => req.owner!._id)] },
    async (req, reply) => {
      const body = parseOrError(RequestBody, req.body, reply);
      if (!body) return;
      const doc: IntegrationRequestDoc = {
        _id: newId("irq"),
        frameworkName: body.frameworkName,
        frameworkUrl: body.frameworkUrl ?? null,
        note: body.note ?? null,
        ownerId: req.owner!._id,
        requesterEmail: req.owner!.email,
        status: "new",
        createdAt: new Date(),
      };
      await requests.insert(doc);
      return reply.code(201).send({ request: requestView(doc) });
    },
  );

  app.get("/v1/admin/integrations/requests", { preHandler: adminAuth }, async (req) => {
    const items = await requests.list(paginationOf(req.query));
    const limit = paginationOf(req.query).limit;
    return { items: items.map(requestView), nextCursor: items.length === limit ? items[items.length - 1]!._id : null };
  });

  app.patch<{ Params: { slug: string } }>(
    "/v1/admin/integrations/:slug/status",
    { preHandler: adminAuth },
    async (req, reply) => {
      const catalog = loadIntegrationsCatalog();
      if (!catalog.some((f) => f.slug === req.params.slug)) return sendError(reply, 404, "not_found", "Unknown integration slug");
      const body = parseOrError(StatusBody, req.body, reply);
      if (!body) return;
      const updated = await statusOverrides.upsert(req.params.slug, body.status, req.owner!._id);
      return { slug: req.params.slug, status: updated!.status };
    },
  );
}
