import { agentsRepository, unclaimedProfilesRepository } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fetchAgentCardForDomain, isBareHostname, unclaimedProfileView } from "../domain/lookup.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { requireClaimed } from "../plugins/requireClaimed.js";
import type { ServerDeps } from "../server.js";

const ListBody = z.strictObject({ domain: z.string().min(1).max(253) });

/**
 * docs/SPEC.md §16: unclaimed profiles. A claimed agent that looked up a domain and found
 * it unregistered can list it, so the domain's operator has a page to find and claim. The
 * caller supplies only the domain: everything stored is what the platform itself fetched
 * (the agent card's URL and hash), never caller-supplied facts. Claiming is ordinary
 * domain verification by the operator's own agent (routes/agents.ts), which marks the
 * profile claimed.
 */
export function registerProfilesRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const profiles = unclaimedProfilesRepository(deps.db);
  const agents = agentsRepository(deps.db);

  app.post(
    "/v1/profiles/unclaimed",
    { preHandler: [verifyAgentRequest(deps.db), requireClaimed, rateLimit(deps.db, "profile_list", (req) => req.agent!.doc._id)] },
    async (req, reply) => {
      const body = parseOrError(ListBody, req.body, reply);
      if (!body) return;
      const domain = body.domain.toLowerCase();
      if (!isBareHostname(domain)) return sendError(reply, 422, "domain_invalid", "domain must be a bare hostname, e.g. acme.example");

      const registered =
        (await agents.collection.findOne({ "domainVerification.domain": domain, "domainVerification.status": "verified" })) ??
        (await agents.collection.findOne({ homepageDomain: domain }));
      if (registered) {
        return sendError(reply, 409, "already_registered", "An agent on OpenGlass already claims this domain", { agentId: registered._id });
      }

      const card = await fetchAgentCardForDomain(domain);
      const { profile, created } = await profiles.list({
        domain,
        listedBy: req.agent!.doc._id,
        agentCardUrl: card?.url ?? null,
        cardSha256: card?.sha256 ?? null,
        now: new Date(),
      });
      return reply.code(created ? 201 : 200).send({ profile: unclaimedProfileView(profile, deps.publicUrl) });
    },
  );

  app.get<{ Params: { domain: string } }>(
    "/v1/profiles/unclaimed/:domain",
    { preHandler: rateLimit(deps.db, "read", (req) => req.ip) },
    async (req, reply) => {
      const profile = await profiles.findByDomain(req.params.domain.toLowerCase());
      if (!profile) return sendError(reply, 404, "not_found", "No unclaimed profile for this domain");
      return { profile: unclaimedProfileView(profile, deps.publicUrl) };
    },
  );
}
