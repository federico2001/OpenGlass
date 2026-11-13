import { createHash } from "node:crypto";
import {
  agentsRepository,
  attestationsRepository,
  records,
  sessions,
  unclaimedProfilesRepository,
  type AgentDoc,
  type RecordDoc,
  type UnclaimedProfileDoc,
} from "@openglass/db";
import type { Db } from "mongodb";
import { resolvesToPublicAddress } from "./domainVerification.js";

const ACTIVITY_WINDOW_MS = 90 * 24 * 3_600_000;
const NEW_AGENT_WINDOW_MS = 7 * 24 * 3_600_000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65_536; // an agent card or MCP registry entry, not a file transfer
const CACHE_TTL_MS = 60_000;
/** A session counts once it was accepted; an offer that was never accepted (pending,
 * declined, cancelled, expired) costs nothing to create, so it isn't activity. */
const ACCEPTED_STATUSES = new Set(["active", "paused", "closing", "closed"]);

export interface LookupQuery {
  agentId?: string;
  domain?: string;
  agentCardUrl?: string;
  publicKey?: string;
}

export interface ActivityFacts {
  /** Accepted sessions (active, paused, closing or closed) in the last 90 days, in either
   * role, with any counterparty; and how many distinct counterparties they had. */
  sessionsLast90d: number;
  attestationsLast90d: number;
  distinctCounterparties: number;
  /** Of this agent's *closed* sessions in the window, the share that
   * closed via `agent_closed` (a normal, agent-initiated close) rather than a timeout,
   * suspension, message-limit cutoff, or a declined pause. `null` when there are no
   * closed sessions yet to compute a share from — not the same as 0%. */
  normalCloseShare: number | null;
  /** The subset of the sessions above whose counterparty has a verified domain, and how
   * many distinct verified counterparties — see the module doc comment on why. */
  verifiedSessionsLast90d: number;
  verifiedDistinctCounterparties: number;
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
  /** docs/SPEC.md §16: set when an agent has already listed this domain as an unclaimed
   * profile; `null` otherwise (including for `agentId`/`publicKey` queries). */
  unclaimedProfile: UnclaimedProfileView | null;
}

export interface UnclaimedProfileView {
  domain: string;
  agentCardUrl: string | null;
  cardSha256: string | null;
  cardFetchedAt: string | null;
  listedBy: string;
  listedAt: string;
  lastSeenAt: string;
  claimed: boolean;
  claimedAgentId: string | null;
  claimedAt: string | null;
  profileUrl: string;
  claimUrl: string;
}

export function unclaimedProfileView(doc: UnclaimedProfileDoc, publicUrl: string): UnclaimedProfileView {
  const profileUrl = `${publicUrl}/agents/by-domain/${doc._id}`;
  return {
    domain: doc._id,
    agentCardUrl: doc.agentCardUrl,
    cardSha256: doc.cardSha256,
    cardFetchedAt: doc.cardFetchedAt?.toISOString() ?? null,
    listedBy: doc.listedBy,
    listedAt: doc.listedAt.toISOString(),
    lastSeenAt: doc.lastSeenAt.toISOString(),
    claimed: doc.claimedAgentId !== null,
    claimedAgentId: doc.claimedAgentId,
    claimedAt: doc.claimedAt?.toISOString() ?? null,
    profileUrl,
    claimUrl: `${profileUrl}#claim`,
  };
}

/** A bare DNS hostname (no scheme, port, path or IP literal), lowercase. */
export function isBareHostname(domain: string): boolean {
  if (/^[\d.]+$/.test(domain)) return false; // IPv4 literal
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain);
}

/** The A2A well-known card paths, current first: `agent-card.json` since A2A 0.3,
 * `agent.json` before that. */
export const AGENT_CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"] as const;

export type LookupResult = RegisteredLookupResult | UnregisteredLookupResult;

/**
 * Realignment R2 (docs/SPEC.md §14): `GET /v1/lookup` — no auth, so any AI agent (or a
 * human) can check who they're about to talk to before they do. Everything returned here
 * must already be independently verifiable from something the platform, the agent's own
 * signatures, or a DNS record attests to (CLAUDE.md's "Positioning" rule) — never a
 * rating, review, or anything from session *content*, which stays private regardless of
 * visibility (§13).
 *
 * **Two session counts (revised Oct 19 2026):** the headline `sessionsLast90d`,
 * `distinctCounterparties` and `normalCloseShare` count every accepted session, whoever the
 * counterparty was, so a new or test agent's real activity shows. The `verified*` counts are
 * the subset whose counterparty agent's OWN `domainVerification.status === "verified"`:
 * real, DNS/HTTP-proven control of a domain, which is costly to fake at scale, so those
 * resist padding with disposable sham counterparties. Every counterparty is already claimed
 * by construction (SPEC D3), so "claimed" alone would filter out nothing. Attestation counts
 * have no counterparty, so neither split applies to them.
 */
export function createLookupService(db: Db) {
  const cache = new Map<string, { expiresAt: number; result: LookupResult }>();

  async function lookupAgent(query: LookupQuery, publicUrl: string): Promise<LookupResult> {
    const cacheKey = JSON.stringify(query);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // The outbound fetches are what's worth caching; the unclaimed profile is one indexed
      // read and changes when an agent lists the domain, so it's always read fresh.
      if (cached.result.registered || !query.domain) return cached.result;
      const profile = await unclaimedProfilesRepository(db).findByDomain(query.domain.toLowerCase());
      return { ...cached.result, unclaimedProfile: profile ? unclaimedProfileView(profile, publicUrl) : null };
    }

    const result = await resolveLookup(db, query, publicUrl);
    // A "not registered" answer by agentId/publicKey costs one indexed read and goes stale
    // the moment that agent registers, so only domain/card-URL misses (which make outbound
    // requests) are worth caching.
    if (result.registered || query.domain || query.agentCardUrl) cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    return result;
  }

  return { lookupAgent };
}

async function resolveLookup(db: Db, query: LookupQuery, publicUrl: string): Promise<LookupResult> {
  const agent = await resolveAgentByQuery(db, query);
  if (agent) return buildRegisteredResult(db, agent);
  return buildUnregisteredResult(db, query, publicUrl);
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
    .aggregate<{ status: string; closeReason: string | null; counterpartyAgentId: string; counterpartyVerified: boolean }>([
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
      {
        $project: {
          _id: 0,
          status: 1,
          closeReason: { $ifNull: ["$closing.reason", null] },
          counterpartyAgentId: 1,
          counterpartyVerified: { $eq: ["$counterpartyAgent.domainVerification.status", "verified"] },
        },
      },
    ])
    .toArray();

  const accepted = sessionAgg.filter((s) => ACCEPTED_STATUSES.has(s.status));
  const verified = accepted.filter((s) => s.counterpartyVerified);
  const closed = accepted.filter((s) => s.status === "closed");
  const closedNormally = closed.filter((s) => s.closeReason === "agent_closed");

  const attestationsLast90d = await attestationsRepository(db).collection.countDocuments({
    "attestor.agentId": agentId,
    createdAt: { $gte: windowStart },
  });

  return {
    sessionsLast90d: accepted.length,
    attestationsLast90d,
    distinctCounterparties: new Set(accepted.map((s) => s.counterpartyAgentId)).size,
    normalCloseShare: closed.length > 0 ? closedNormally.length / closed.length : null,
    verifiedSessionsLast90d: verified.length,
    verifiedDistinctCounterparties: new Set(verified.map((s) => s.counterpartyAgentId)).size,
  };
}

async function countOpenDisputes(db: Db, agentId: string): Promise<number> {
  // `dispute` is the flag on any record (SPEC §13.2); legacy sealed records disputed before
  // that field existed only carry `sealedState.status: "disputed"`.
  return db.collection<RecordDoc>(records.name).countDocuments({
    participantAgentIds: agentId,
    $or: [{ dispute: { $type: "object" } }, { "sealedState.status": "disputed" }],
  });
}

async function buildUnregisteredResult(db: Db, query: LookupQuery, publicUrl: string): Promise<UnregisteredLookupResult> {
  const domain = query.domain?.toLowerCase();

  const [card, mcpRegistryEntry, domainRegisteredAt, profile] = await Promise.all([
    query.agentCardUrl
      ? fetchJsonCapped(query.agentCardUrl)
      : domain
        ? fetchAgentCardForDomain(domain).then((c) => c?.json ?? null)
        : Promise.resolve(null),
    domain ? fetchMcpRegistryEntry(domain) : Promise.resolve(null),
    domain ? fetchDomainRegistrationDate(domain) : Promise.resolve(null),
    domain ? unclaimedProfilesRepository(db).findByDomain(domain) : Promise.resolve(null),
  ]);

  return {
    registered: false,
    agentCard: card,
    mcpRegistryEntry,
    domainRegisteredAt,
    // R5 (not yet shipped as of R2) will add a dedicated /agents onboarding page this
    // should point at instead — skill.md is today's real, already-live entry point.
    inviteUrl: `${publicUrl}/skill.md`,
    unclaimedProfile: profile ? unclaimedProfileView(profile, publicUrl) : null,
  };
}

/** Tries each A2A well-known card path on `https://{domain}` in order; the first one that
 * returns JSON wins. */
export async function fetchAgentCardForDomain(
  domain: string,
  fetchCard: AgentCardFetcher = fetchJsonWithHash,
): Promise<{ url: string; json: unknown; sha256: string } | null> {
  for (const path of AGENT_CARD_PATHS) {
    const url = `https://${domain}${path}`;
    const fetched = await fetchCard(url);
    if (fetched) return { url, ...fetched };
  }
  return null;
}

/** SSRF-safe fetch for an agent-supplied URL (agentCardUrl, or a domain-derived
 * well-known path) — same guard as domainVerification.ts's fetch: resolve first and
 * refuse a private/loopback/link-local address, never follow a redirect. Returns `null`
 * on any failure, including a non-JSON body. */
async function fetchJsonCapped(url: string): Promise<unknown | null> {
  return (await fetchJsonWithHash(url))?.json ?? null;
}

/** Fetches a JSON document and the sha256 of its bytes, or null. */
export type AgentCardFetcher = (url: string) => Promise<{ json: unknown; sha256: string } | null>;

export async function fetchJsonWithHash(url: string): Promise<{ json: unknown; sha256: string } | null> {
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
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    return { json: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
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
