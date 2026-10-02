import { agentsRepository, unclaimedProfilesRepository } from "@openglass/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { fetchAgentCardForDomain, fetchJsonWithHash, isBareHostname, unclaimedProfileView } from "../domain/lookup.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { verifyOwnerSession } from "../plugins/ownerAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { requireClaimed } from "../plugins/requireClaimed.js";
import type { ServerDeps } from "../server.js";

/** Exactly one way to name the counterparty: its domain, the URL of its agent card, or the
 * agent card itself (as the caller received it, e.g. during A2A discovery). */
const ListBody = z.union([
  z.strictObject({ domain: z.string().min(1).max(253) }),
  z.strictObject({ agentCardUrl: z.string().min(1).max(2048) }),
  z.strictObject({ agentCard: z.record(z.string(), z.unknown()) }),
]);

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The OpenGlass agent a card points back to, if it carries OpenGlass's own breadcrumb
 * (`"x-openglass": { agentId }`, docs/SPEC.md §8.1). */
function breadcrumbAgentId(card: unknown): string | null {
  const id = isJsonObject(card) && isJsonObject(card["x-openglass"]) ? card["x-openglass"].agentId : null;
  return typeof id === "string" ? id : null;
}

/** A card URL the platform will fetch: https, default port, bare hostname. */
function parseCardUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
    return isBareHostname(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

/** The domain an agent card describes: the host of its service `url` (A2A 0.3), or of its
 * first `supportedInterfaces[].url` (A2A 1.0). */
function domainOfCard(card: Record<string, unknown>): string | null {
  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const candidates = [card.url, ...interfaces.map((i) => (isJsonObject(i) ? i.url : null))];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      if (url.protocol === "https:" && isBareHostname(host)) return host;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * docs/SPEC.md §16: unclaimed profiles. A claimed agent that met a counterparty not
 * registered on OpenGlass can list it, so the counterparty's operator has a page to find
 * and claim, and the listing agent's owner sees it among their counterparties. The caller
 * names the counterparty by domain, agent card URL, or the agent card itself; everything
 * stored is what the platform fetched itself (the card's URL and hash), never facts the
 * caller supplied. Claiming is ordinary domain verification by the operator's own agent
 * (routes/agents.ts), which marks the profile claimed.
 */
export function registerProfilesRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const profiles = unclaimedProfilesRepository(deps.db);
  const agents = agentsRepository(deps.db);
  const fetchCard = deps.fetchAgentCard ?? fetchJsonWithHash;

  async function alreadyRegistered(reply: FastifyReply, domain: string, cardAgentId: string | null): Promise<boolean> {
    const registered =
      (cardAgentId ? await agents.findById(cardAgentId) : null) ??
      (await agents.collection.findOne({ "domainVerification.domain": domain, "domainVerification.status": "verified" })) ??
      (await agents.collection.findOne({ homepageDomain: domain }));
    if (!registered) return false;
    sendError(reply, 409, "already_registered", "An agent on OpenGlass already claims this domain", { agentId: registered._id });
    return true;
  }

  app.post(
    "/v1/profiles/unclaimed",
    { preHandler: [verifyAgentRequest(deps.db), requireClaimed, rateLimit(deps.db, "profile_list", (req) => req.agent!.doc._id)] },
    async (req, reply) => {
      const body = parseOrError(ListBody, req.body, reply);
      if (!body) return;

      let domain: string;
      let card: { url: string; sha256: string } | null;
      if ("agentCardUrl" in body) {
        // The card at exactly this URL, fetched by the platform with the lookup SSRF guard.
        const url = parseCardUrl(body.agentCardUrl);
        if (!url) return sendError(reply, 422, "agent_card_url_invalid", "agentCardUrl must be an https URL on a bare hostname, with no port");
        const fetched = await fetchCard(url.href);
        if (!fetched || !isJsonObject(fetched.json)) {
          return sendError(reply, 422, "agent_card_unreachable", "No JSON agent card could be fetched from agentCardUrl");
        }
        domain = url.hostname.toLowerCase();
        if (await alreadyRegistered(reply, domain, breadcrumbAgentId(fetched.json))) return;
        card = { url: url.href, sha256: fetched.sha256 };
      } else {
        // A domain, or the card itself: the card is only used to find its domain. The
        // platform then fetches the domain's own well-known card, so nothing the caller
        // sent is stored.
        let cardAgentId: string | null = null;
        if ("agentCard" in body) {
          const found = domainOfCard(body.agentCard);
          if (!found) return sendError(reply, 422, "agent_card_invalid", "agentCard has no https service url to take a domain from");
          domain = found;
          cardAgentId = breadcrumbAgentId(body.agentCard);
        } else {
          domain = body.domain.toLowerCase();
          if (!isBareHostname(domain)) return sendError(reply, 422, "domain_invalid", "domain must be a bare hostname, e.g. acme.example");
        }
        if (await alreadyRegistered(reply, domain, cardAgentId)) return;
        card = await fetchAgentCardForDomain(domain, fetchCard);
      }

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

  // Owner dashboard: the counterparties the caller's own agents listed, newest first, each
  // with the profile as it stands now (claimed or not).
  app.get(
    "/v1/owner/counterparty-profiles",
    { preHandler: verifyOwnerSession(deps.db, { webOrigin: deps.webOrigin }) },
    async (req) => {
      const q = req.query as { limit?: string };
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const myAgentIds = (await agents.collection.find({ ownerId: req.owner!._id }, { projection: { _id: 1 } }).toArray()).map((a) => a._id);
      const listings = myAgentIds.length ? await profiles.listingsByAgents(myAgentIds, limit) : [];
      const byDomain = new Map((await profiles.findByDomains([...new Set(listings.map((l) => l.domain))])).map((p) => [p._id, p]));
      return {
        items: listings.flatMap((l) => {
          const profile = byDomain.get(l.domain);
          if (!profile) return [];
          return [
            {
              listedByAgentId: l.agentId,
              firstListedAt: l.firstListedAt.toISOString(),
              lastListedAt: l.lastListedAt.toISOString(),
              profile: unclaimedProfileView(profile, deps.publicUrl),
            },
          ];
        }),
      };
    },
  );
}
