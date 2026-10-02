import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createLookupService, isBareHostname } from "../domain/lookup.js";
import { parseOrError, sendError } from "../errors.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

const LookupQuery = z
  .object({
    agentId: z.string().optional(),
    domain: z.string().max(253).optional(),
    agentCardUrl: z.url().optional(),
    publicKey: z.string().optional(),
  })
  .refine((q) => [q.agentId, q.domain, q.agentCardUrl, q.publicKey].filter((v) => v !== undefined).length === 1, {
    message: "exactly one of agentId, domain, agentCardUrl, publicKey is required",
  });

/**
 * Realignment R2 (docs/SPEC.md §14): `GET /v1/lookup` — check who you're talking to before
 * you talk to them. Public (no auth): the whole point is that a calling agent can look up
 * a counterparty it has no relationship with yet. See domain/lookup.ts for what's actually
 * computed and why (including the documented anti-gaming rule).
 */
export function registerLookupRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const lookup = createLookupService(deps.db);

  app.get("/v1/lookup", { preHandler: rateLimit(deps.db, "lookup", (req) => req.ip) }, async (req, reply) => {
    const query = parseOrError(LookupQuery, req.query, reply);
    if (!query) return;
    const domain = query.domain?.toLowerCase();
    if (domain !== undefined) {
      if (!isBareHostname(domain)) return sendError(reply, 422, "domain_invalid", "domain must be a bare hostname, e.g. acme.example");
    }
    const result = await lookup.lookupAgent({ ...query, domain }, deps.publicUrl);
    return result;
  });
}
