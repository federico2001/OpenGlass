import { inspectTls, NetError, resolvePublic, safeFetch, type TlsFacts } from "../net.js";
import { domainOf, type Target } from "../target.js";
import { clamp, type CheckDeps, type Finding, type Section } from "./types.js";

const MAX_REGISTRY_BYTES = 512 * 1024;

export interface RegistryFacts {
  /** null when the registry couldn't be reached (not counted against the target). */
  listed: boolean | null;
  agentId: string | null;
  healthy: boolean | null;
  taskVerified: boolean | null;
  uptimePercent: number | null;
  error: string | null;
}

export interface IdentityDetails {
  domain: string | null;
  dns: { resolves: boolean; addresses: number; error: string | null };
  tls: TlsFacts | null;
  provider: { organization: boolean; url: boolean };
  registry: RegistryFacts;
}

/** Public signals only: nothing here asks the target to prove anything. */
export async function checkIdentity(
  target: Target,
  cardPromise: Promise<Record<string, unknown> | null>,
  deps: CheckDeps,
): Promise<Section<IdentityDetails>> {
  const domain = domainOf(target);
  const findings: Finding[] = [];
  const parts: string[] = [];
  const registryRun = domain ? lookUpRegistry(domain, deps) : Promise.resolve(emptyRegistry("no domain to look up"));

  let dns: IdentityDetails["dns"];
  try {
    const addresses = await resolvePublic(target.host, deps.net);
    dns = { resolves: true, addresses: addresses.length, error: null };
  } catch (err) {
    dns = { resolves: false, addresses: 0, error: err instanceof NetError ? err.message : "lookup failed" };
  }

  const url = new URL(target.origin);
  let tls: TlsFacts | null = null;
  if (url.protocol === "https:" && dns.resolves) {
    try {
      tls = await inspectTls(target.host, Number(url.port || 443), deps.net);
    } catch (err) {
      tls = { valid: false, error: err instanceof NetError ? err.message : "TLS check failed", validTo: null, daysRemaining: null, issuer: null };
    }
  }

  const card = await cardPromise;
  const provider = (card?.provider ?? {}) as { organization?: unknown; url?: unknown };
  const providerFacts = {
    organization: typeof provider.organization === "string" && provider.organization.trim() !== "",
    url: typeof provider.url === "string" && provider.url.trim() !== "",
  };

  const registry = await registryRun;

  // Points: DNS 30, TLS 30, provider 20, registry 20 (dropped when the registry was unreachable).
  let earned = 0;
  let possible = 0;

  possible += 30;
  if (dns.resolves) {
    earned += 30;
    parts.push("resolves");
  } else {
    parts.push("doesn't resolve");
    findings.push({ severity: "high", fix: `Make ${target.host} resolve to a public address.` });
  }

  possible += 30;
  if (url.protocol !== "https:") {
    parts.push("no HTTPS");
    findings.push({ severity: "high", fix: "Serve the agent over HTTPS with a valid certificate." });
  } else if (tls?.valid) {
    const soon = tls.daysRemaining !== null && tls.daysRemaining < 14;
    earned += soon ? 20 : 30;
    parts.push(`valid TLS${tls.daysRemaining !== null ? ` (expires in ${tls.daysRemaining} days)` : ""}`);
    if (soon) findings.push({ severity: "medium", fix: `Renew the TLS certificate; it expires in ${tls.daysRemaining} days.` });
  } else if (tls) {
    parts.push(`TLS invalid (${tls.error})`);
    findings.push({ severity: "high", fix: "Install a valid TLS certificate for the agent's host." });
  }

  // Without a card there are no provider fields to read; the card section already says so.
  if (card) {
    possible += 20;
    earned += (providerFacts.organization ? 10 : 0) + (providerFacts.url ? 10 : 0);
    if (providerFacts.organization && providerFacts.url) parts.push("provider named");
    else {
      parts.push("no provider on the card");
      findings.push({ severity: "low", fix: "Name who runs the agent: provider.organization and provider.url on the card." });
    }
  }

  if (registry.listed !== null) {
    possible += 20;
    if (registry.listed) {
      earned += 10 + (registry.taskVerified || registry.healthy ? 10 : 0);
      parts.push(
        `listed in the A2A Registry${registry.uptimePercent !== null ? ` (${registry.uptimePercent}% uptime)` : ""}${registry.taskVerified ? ", task-verified" : ""}`,
      );
    } else {
      parts.push("not in the A2A Registry");
      findings.push({ severity: "low", fix: "List the agent in the A2A Registry (a2aregistry.org) so others can find it and see its uptime." });
    }
  } else {
    parts.push("A2A Registry not reachable");
  }

  return {
    score: possible === 0 ? null : clamp((earned / possible) * 100),
    summary: `${target.host}: ${parts.join(", ")}.`,
    findings,
    details: { domain, dns, tls, provider: providerFacts, registry },
  };
}

function emptyRegistry(error: string | null): RegistryFacts {
  return { listed: null, agentId: null, healthy: null, taskVerified: null, uptimePercent: null, error };
}

async function getJson(url: string, deps: CheckDeps): Promise<unknown> {
  const res = await safeFetch(url, { maxBytes: MAX_REGISTRY_BYTES, headers: { accept: "application/json" } }, deps.net);
  if (res.status !== 200) throw new NetError("network", `HTTP ${res.status}`);
  return JSON.parse(res.body.toString("utf8"));
}

/** The A2A Registry's public API: `GET /api/agents?search=` to find the listing, then
 * `GET /api/agents/{id}/uptime`. The response shapes aren't formally specified, so this
 * reads them tolerantly and reports "unknown" rather than guessing. */
export async function lookUpRegistry(domain: string, deps: CheckDeps): Promise<RegistryFacts> {
  const base = deps.registryUrl.replace(/\/+$/, "");
  let items: Record<string, unknown>[];
  try {
    const body = await getJson(`${base}/api/agents?search=${encodeURIComponent(domain)}&limit=50`, deps);
    const list = Array.isArray(body) ? body : ((body as Record<string, unknown>)?.agents ?? (body as Record<string, unknown>)?.items ?? (body as Record<string, unknown>)?.data);
    if (!Array.isArray(list)) return emptyRegistry("unexpected response from the registry");
    items = list.filter((i): i is Record<string, unknown> => !!i && typeof i === "object");
  } catch (err) {
    return emptyRegistry(err instanceof Error ? err.message : "registry request failed");
  }

  const match = items.find((item) => urlsOf(item).some((u) => hostOf(u) === domain));
  if (!match) return { ...emptyRegistry(null), listed: false };

  const agentId = String(match.id ?? match.agent_id ?? match.agentId ?? "");
  const conformance = match.task_conformance as { category?: unknown; verified?: unknown } | undefined;
  const facts: RegistryFacts = {
    listed: true,
    agentId: agentId || null,
    healthy: typeof match.is_healthy === "boolean" ? match.is_healthy : null,
    taskVerified:
      typeof match.task_verified === "boolean"
        ? match.task_verified
        : conformance
          ? conformance.verified === true || String(conformance.category ?? "").toUpperCase() === "WORKING"
          : null,
    uptimePercent: percentOf(match),
    error: null,
  };
  if (agentId) {
    try {
      const uptime = await getJson(`${base}/api/agents/${encodeURIComponent(agentId)}/uptime`, deps);
      facts.uptimePercent = percentOf(uptime) ?? facts.uptimePercent;
    } catch {
      /* uptime is optional */
    }
  }
  return facts;
}

function urlsOf(item: Record<string, unknown>): string[] {
  return ["wellKnownURI", "well_known_uri", "url", "agent_card_url", "agentCardUrl", "endpoint"]
    .map((k) => item[k])
    .filter((v): v is string => typeof v === "string");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function percentOf(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  for (const key of ["uptime_percentage", "uptimePercentage", "uptime_percent", "uptime", "percentage"]) {
    const n = v[key];
    if (typeof n === "number" && Number.isFinite(n)) return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
  }
  return null;
}
