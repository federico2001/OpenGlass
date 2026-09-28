import { agentsRepository, attestationsRepository, records, sessions, type AgentDoc, type RecordDoc } from "@openglass/db";
import type { Db } from "mongodb";
import { resolvesToPublicAddress } from "./domainVerification.js";

const ACTIVITY_WINDOW_MS = 90 * 24 * 3_600_000;
const NEW_AGENT_WINDOW_MS = 7 * 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65_536; // an agent card or MCP registry entry, not a file transfer
const CACHE_TTL_MS = 60_000;

export interface LookupQuery {
  agentId?: string;
  domain?: string;
  agentCardUrl?: string;
  publicKey?: string;
}

export interface ActivityFacts {
  /** Sessions AND attestations in the last 90 days. Session counts (and everything
   * derived from them below) only include sessions whose counterparty is itself a
   * domain-verified agent — see the module doc comment on why. */
  sessionsLast90d: number;
  attestationsLast90d: number;
  distinctCounterparties: number;
  /** Of this agent's *closed* sessions (within the counted set above), the share that
   * closed via `agent_closed` (a normal, agent-initiated close) rather than a timeout,
   * suspension, message-limit cutoff, or a declined pause. `null` when there are no
   * closed sessions yet to compute a share from — not the same as 0%. */
  normalCloseShare: number | null;
}

export interface LookupFlags {
  newAgent: boolean;
  unverifiedDomain: boolean;
  recentlyRotatedKey: boolean;
}

export interface RegisteredLookupResult {
  registered: true;
  agentId: string;
  name: string;
  claimed: boolean;
  verifiedOwner: { domain: string } | null;
  firstSeen: string;
  keyAgeDays: number;
  /** Self-reported (`meta.software`, e.g. "acme-agent/2.3") — not independently verified,
   * shown as-is for realignment R3's public profile pages ("integrations used"). There's
   * no dedicated integration-tracking system to draw a stronger signal from yet. */
  software: string | null;
  activity: ActivityFacts;
  openDisputesCount: number;
  flags: LookupFlags;
}

export interface UnregisteredLookupResult {
  registered: false;
  agentCard: unknown | null;
  mcpRegistryEntry: unknown | null;
  domainRegisteredAt: string | null;
  inviteUrl: string;
}

export type LookupResult = RegisteredLookupResult | UnregisteredLookupResult;

/**
 * Realignment R2 (docs/SPEC.md §14): `GET /v1/lookup` — no auth, so any AI agent (or a
 * human) can check who they're about to talk to before they do. Everything returned here
 * must already be independently verifiable from something the platform, the agent's own
 * signatures, or a DNS record attests to (CLAUDE.md's "Positioning" rule) — never a
 * rating, review, or anything from session *content*, which stays private regardless of
 * visibility (§13).
 *
 * **Anti-gaming (documented per R2's own instruction):** every count in `ActivityFacts`
 * that involves a counterparty (sessions, distinct counterparties, normal-close share)
 * only counts interactions where that counterparty agent's OWN `domainVerification.status
 * === "verified"` — real, DNS/HTTP-proven control of a domain. This is deliberately the
 * *strong* verification tier (not merely "claimed by some owner"): every session
 * counterparty is already claimed by construction (SPEC D3 — an unclaimed agent can't
 * accept a session), so "claimed" alone would filter out nothing and provide zero
 * protection against an attacker padding a target's numbers with disposable sham
 * counterparty agents. Domain verification, by contrast, requires controlling a real DNS
 * zone or web server per counterparty — genuinely costly to fake at scale. The honest
 * cost of this choice: today, while domain verification adoption is still low, most
 * agents' real activity numbers will read as 0 or near it. That's an intentional
 * trade-off — a metric that's low but ungameable beats one that's inflated and
 * meaningless. Attestation counts have no counterparty at all, so this filter doesn't
 * apply to them.
 */
export function createLookupService(db: Db) {
  const cache = new Map<string, { expiresAt: number; result: LookupResult }>();

  async function lookupAgent(query: LookupQuery, publicUrl: string): Promise<LookupResult> {
    const cacheKey = JSON.stringify(query);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const result = await resolveLookup(db, query, publicUrl);
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    return result;
  }

  return { lookupAgent };
}

async function resolveLookup(db: Db, query: LookupQuery, publicUrl: string): Promise<LookupResult> {
  const agent = await resolveAgentByQuery(db, query);
  if (agent) return buildRegisteredResult(db, agent);
  return buildUnregisteredResult(query, publicUrl);
}

async function resolveAgentByQuery(db: Db, query: LookupQuery): Promise<AgentDoc | null> {
  const agents = agentsRepository(db);
  if (query.agentId) return agents.findById(query.agentId);
  if (query.publicKey) return agents.findByPublicKey(query.publicKey);
  if (query.domain) {
    const domain = query.domain.toLowerCase();
    // Prefer a verified match; an unverified homepage claim on the same domain is a
    // weaker but still worth-surfacing signal (reported with flags.unverifiedDomain).
    const verified = await agents.collection.findOne({ "domainVerification.domain": domain, "domainVerification.status": "verified" });
    if (verified) return verified;
    return agents.collection.findOne({ homepageDomain: domain });
  }
  if (query.agentCardUrl) {
    // OpenGlass's own agent.json embeds an "x-openglass.agentId" breadcrumb (see
    // routes/agents.ts's agentCardFor) — if the fetched card is one of ours, resolve it
    // to the real registered agent instead of treating a known agent as "unregistered".
    const card = await fetchJsonCapped(query.agentCardUrl);
    const breadcrumbAgentId = (card as { "x-openglass"?: { agentId?: string } } | null)?.["x-openglass"]?.agentId;
    if (breadcrumbAgentId) return agents.findById(breadcrumbAgentId);
    return null;
  }
  return null;
}

async function buildRegisteredResult(db: Db, agent: AgentDoc): Promise<RegisteredLookupResult> {
  const now = new Date();
  const activeKey = agent.keys.find((k) => !k.revokedAt) ?? agent.keys[0]!;
  const [activity, openDisputesCount] = await Promise.all([computeActivityFacts(db, agent._id, now), countOpenDisputes(db, agent._id)]);

  return {
    registered: true,
    agentId: agent._id,
    name: agent.name,
    claimed: agent.ownerId !== null,
    verifiedOwner: agent.domainVerification?.status === "verified" ? { domain: agent.domainVerification.domain } : null,
    firstSeen: agent.createdAt.toISOString(),
    keyAgeDays: Math.floor((now.getTime() - activeKey.createdAt.getTime()) / 86_400_000),
    software: agent.meta.software ?? null,
    activity,
    openDisputesCount,
    flags: {
      newAgent: now.getTime() - agent.createdAt.getTime() < NEW_AGENT_WINDOW_MS,
      unverifiedDomain: !!agent.meta.homepage && agent.domainVerification?.status !== "verified",
      recentlyRotatedKey: agent.keys.length > 1 && now.getTime() - activeKey.createdAt.getTime() < NEW_AGENT_WINDOW_MS,
    },
  };
}

async function computeActivityFacts(db: Db, agentId: string, now: Date): Promise<ActivityFacts> {
  const windowStart = new Date(now.getTime() - ACTIVITY_WINDOW_MS);

  const sessionAgg = await db
    .collection(sessions.name)
    .aggregate<{ status: string; closeReason: string | null; counterpartyAgentId: string }>([
      {
        $match: {
          $or: [{ "initiator.agentId": agentId }, { "counterparty.agentId": agentId }],
          createdAt: { $gte: windowStart },
        },
      },
      {
        $addFields: {
          counterpartyAgentId: { $cond: [{ $eq: ["$initiator.agentId", agentId] }, "$counterparty.agentId", "$initiator.agentId"] },
        },
      },
      { $match: { counterpartyAgentId: { $ne: null } } },
      { $lookup: { from: "agents", localField: "counterpartyAgentId", foreignField: "_id", as: "counterpartyAgent" } },
      { $unwind: "$counterpartyAgent" },
      { $match: { "counterpartyAgent.domainVerification.status": "verified" } },
      {
        $project: {
          _id: 0,
          status: 1,
          closeReason: { $ifNull: ["$closing.reason", null] },
          counterpartyAgentId: 1,
        },
      },
    ])
    .toArray();

  const distinctCounterparties = new Set(sessionAgg.map((s) => s.counterpartyAgentId)).size;
  const closed = sessionAgg.filter((s) => s.status === "closed");
  const closedNormally = closed.filter((s) => s.closeReason === "agent_closed");

  const attestationsLast90d = await attestationsRepository(db).collection.countDocuments({
    "attestor.agentId": agentId,
    createdAt: { $gte: windowStart },
  });

  return {
    sessionsLast90d: sessionAgg.length,
    attestationsLast90d,
    distinctCounterparties,
    normalCloseShare: closed.length > 0 ? closedNormally.length / closed.length : null,
  };
}

async function countOpenDisputes(db: Db, agentId: string): Promise<number> {
  return db.collection<RecordDoc>(records.name).countDocuments({ participantAgentIds: agentId, "sealedState.status": "disputed" });
}

async function buildUnregisteredResult(query: LookupQuery, publicUrl: string): Promise<UnregisteredLookupResult> {
  const domain = query.domain?.toLowerCase();
  const cardUrl = query.agentCardUrl ?? (domain ? `https://${domain}/.well-known/agent.json` : null);

  const [agentCard, mcpRegistryEntry, domainRegisteredAt] = await Promise.all([
    cardUrl ? fetchJsonCapped(cardUrl) : Promise.resolve(null),
    domain ? fetchMcpRegistryEntry(domain) : Promise.resolve(null),
    domain ? fetchDomainRegistrationDate(domain) : Promise.resolve(null),
  ]);

  return {
    registered: false,
    agentCard,
    mcpRegistryEntry,
    domainRegisteredAt,
    // R5 (not yet shipped as of R2) will add a dedicated /agents onboarding page this
    // should point at instead — skill.md is today's real, already-live entry point.
    inviteUrl: `${publicUrl}/skill.md`,
  };
}

/** SSRF-safe fetch for an agent-supplied URL (agentCardUrl, or a domain-derived
 * well-known path) — same guard as domainVerification.ts's fetch: resolve first and
 * refuse a private/loopback/link-local address, never follow a redirect. Returns `null`
 * on any failure, including a non-JSON body. */
async function fetchJsonCapped(url: string): Promise<unknown | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!(await resolvesToPublicAddress(hostname))) return null;
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    let received = 0;
    let text = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Best-effort: the official MCP Registry's public search API (verified live against
 * registry.modelcontextprotocol.io while building this). Not agent-supplied input (the
 * URL is built from a fixed host plus the query param), so no SSRF guard is needed here —
 * only graceful failure, since this is an external service OpenGlass doesn't control and
 * its shape could change. */
async function fetchMcpRegistryEntry(domain: string): Promise<unknown | null> {
  try {
    const res = await fetch(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { servers?: unknown[] };
    return Array.isArray(body.servers) && body.servers.length > 0 ? body.servers[0] : null;
  } catch {
    return null;
  }
}

/** Best-effort domain registration date via RDAP (rdap.org bootstraps to the right
 * registry for the TLD). Unlike an agent-supplied URL, rdap.org's redirect target is
 * chosen by IANA's own bootstrap registry, not by the caller, so following it is safe. */
async function fetchDomainRegistrationDate(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
    return body.events?.find((e) => e.eventAction === "registration")?.eventDate ?? null;
  } catch {
    return null;
  }
}
