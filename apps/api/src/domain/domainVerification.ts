import { randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, resolveTxt } from "node:dns/promises";

/**
 * Domain verification (Prompt 4 follow-up, extended by realignment R2, docs/SPEC.md §14):
 * an agent proves it controls a domain by publishing a server-generated token one of three
 * ways — an HTTP well-known .txt file (the original method, at `meta.homepage`), an HTTP
 * well-known JSON file, or a DNS TXT record — the same shape as Google Search Console's
 * multiple verification methods or an ACME challenge. The token isn't a secret — anyone
 * who already controls that web server/DNS zone can publish it; knowing the token doesn't
 * let anyone who doesn't already control either of those do anything with it.
 * `checkDomainVerification` tries all three and succeeds if any one matches, so the caller
 * never has to say which method they used.
 *
 * `meta.homepage` is agent-controlled input, and the two HTTP methods make the platform's
 * own server fetch it (SSRF, OWASP A10) — an unclaimed or malicious agent could otherwise
 * point it at an internal service or a cloud metadata endpoint. `resolvesToPublicAddress`
 * below resolves the hostname and rejects anything that isn't a public address before any
 * request is made. This narrows but doesn't eliminate DNS-rebinding risk (the name could
 * re-resolve between this check and the actual fetch) — full protection needs pinning the
 * checked IP for the connection itself, which plain `fetch()` has no hook for; that's a
 * known residual gap, not something silently ignored. The DNS TXT method has no such risk
 * — a TXT lookup never fetches anything the response could redirect elsewhere.
 */

const VERIFICATION_PATH = "/.well-known/openglass-agent-verification.txt";
const WELL_KNOWN_JSON_PATH = "/.well-known/openglass.json";
/** DNS TXT record host: `_openglass.<domain>` — the same underscore-prefixed subdomain
 * convention as `_dmarc.<domain>` or an ACME `_acme-challenge.<domain>` record. */
const DNS_TXT_PREFIX = "_openglass.";
const FETCH_TIMEOUT_MS = 5000;
const DNS_TIMEOUT_MS = 5000;
/** Real HTTP responses only; refuses to "verify" a domain by trusting a redirect target
 * that could point anywhere, including somewhere the agent doesn't control. */
const MAX_RESPONSE_BYTES = 4096;

export function generateVerificationToken(): string {
  return randomBytes(16).toString("hex");
}

/** Extracts the hostname `meta.homepage` claims, requiring `https:` and a real DNS name
 * (not a bare IP literal — a legitimate public website has one). Returns `null` for
 * anything else, including a homepage that isn't set at all. */
export function domainFromHomepage(homepage: string | undefined): string | null {
  if (!homepage) return null;
  try {
    const url = new URL(homepage);
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    // URL.hostname keeps the brackets for an IPv6 literal ("[::1]"), which net.isIP doesn't
    // recognize as an IP on its own — strip them before checking, or a bracketed IPv6
    // literal would slip through as if it were a domain name.
    const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (isIP(bareHost) !== 0) return null; // reject IP-literal hosts outright
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
    return hostname;
  } catch {
    return null;
  }
}

/** Private/loopback/link-local/CGNAT/reserved/multicast ranges — the same list
 * apps/checkup/src/net.ts uses to guard its own outbound requests to third-party agents,
 * via `node:net`'s `BlockList` rather than hand-rolled octet comparisons. Covers
 * everything the original narrower check did (RFC 1918, loopback, link-local,
 * multicast/reserved) plus CGNAT (100.64.0.0/10) and the IETF special-purpose ranges
 * (protocol assignments, documentation, benchmarking) a scanner could otherwise probe. */
const BLOCKED_IPV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_IPV4.addSubnet(net, prefix, "ipv4");
}

const BLOCKED_IPV6 = new BlockList();
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_IPV6.addSubnet(net, prefix, "ipv6");
}

export function isPublicIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  return !BLOCKED_IPV4.check(ip, "ipv4");
}

/** Also unwraps an IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) address and
 * checks the IPv4 address it actually carries, rather than just the IPv6 wrapper — a
 * private IPv4 address embedded this way would otherwise slip past the IPv6 blocklist,
 * which has no entry for it at all. */
export function isPublicIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return isPublicIpv4(embedded[1]!);
  if (isIP(lower) !== 6) return false;
  return !BLOCKED_IPV6.check(lower, "ipv6");
}

/** Resolves every address the hostname's DNS currently answers with and requires all of
 * them to be public — a hostname that resolves to even one private/loopback/link-local
 * address is rejected, so an attacker can't round-robin between a public "decoy" answer
 * and an internal one. */
export async function resolvesToPublicAddress(hostname: string): Promise<boolean> {
  try {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return false;
    return addresses.every((a) => (a.family === 4 ? isPublicIpv4(a.address) : isPublicIpv6(a.address)));
  } catch {
    return false;
  }
}

export function verificationFileUrl(domain: string): string {
  return `https://${domain}${VERIFICATION_PATH}`;
}

export function wellKnownJsonUrl(domain: string): string {
  return `https://${domain}${WELL_KNOWN_JSON_PATH}`;
}

export function dnsTxtRecordName(domain: string): string {
  return `${DNS_TXT_PREFIX}${domain}`;
}

/** Fetches `url`, capped at `MAX_RESPONSE_BYTES`, refusing to follow a redirect (the agent
 * doesn't necessarily control the redirect target). Returns `null` on any failure — a
 * network error, timeout, or non-200 response — never throws. */
async function fetchTextCapped(url: string): Promise<string | null> {
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
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text;
  } catch {
    return null;
  }
}

/** Method 1 (original): a well-known .txt file containing the token on its own line
 * (trimmed whitespace tolerated). */
async function checkWellKnownTxt(domain: string, token: string): Promise<boolean> {
  const text = await fetchTextCapped(verificationFileUrl(domain));
  if (text === null) return false;
  return text
    .split("\n")
    .map((line) => line.trim())
    .includes(token);
}

/** Method 2: a well-known JSON file, `{"token": "<token>"}` — same shape/intent as the
 * .txt method for a domain that would rather publish structured data. */
async function checkWellKnownJson(domain: string, token: string): Promise<boolean> {
  const text = await fetchTextCapped(wellKnownJsonUrl(domain));
  if (text === null) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).token === token;
  } catch {
    return false;
  }
}

/** Method 3: a DNS TXT record at `_openglass.<domain>` whose value is exactly the token.
 * No SSRF exposure — a TXT lookup never fetches a URL the response could point elsewhere. */
async function checkDnsTxt(domain: string, token: string): Promise<boolean> {
  try {
    const records = await Promise.race([
      resolveTxt(dnsTxtRecordName(domain)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS)),
    ]);
    // Each TXT record comes back as an array of chunks (long values get split across
    // multiple <character-string>s by the DNS wire format); join before comparing.
    return records.some((chunks) => chunks.join("").trim() === token);
  } catch {
    return false;
  }
}

/** Tries all three verification methods and succeeds if any one matches — the caller never
 * has to say which method they used. Never throws; each method already swallows its own
 * failures (network error, timeout, missing/malformed record, wrong token) as "not this
 * method". The two HTTP methods additionally require the hostname to resolve to a public
 * address (SSRF guard) before ever making a request. */
export async function checkDomainVerification(domain: string, token: string): Promise<boolean> {
  if (await checkDnsTxt(domain, token)) return true;
  if (!(await resolvesToPublicAddress(domain))) return false;
  if (await checkWellKnownTxt(domain, token)) return true;
  if (await checkWellKnownJson(domain, token)) return true;
  return false;
}
