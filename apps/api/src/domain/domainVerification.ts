import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Domain verification (Prompt 4 follow-up): an agent proves it controls the web server at
 * its own `meta.homepage` by publishing a server-generated token at a well-known path,
 * the same shape as Google Search Console's HTML-file method or an ACME http-01
 * challenge. The token isn't a secret — anyone who already controls that web server can
 * publish it; knowing the token doesn't let anyone who doesn't already control the server
 * do anything with it.
 *
 * `meta.homepage` is agent-controlled input, and this makes the platform's own server
 * fetch it (SSRF, OWASP A10) — an unclaimed or malicious agent could otherwise point it at
 * an internal service or a cloud metadata endpoint. `resolvesToPublicAddress` below
 * resolves the hostname and rejects anything that isn't a public address before any
 * request is made. This narrows but doesn't eliminate DNS-rebinding risk (the name could
 * re-resolve between this check and the actual fetch) — full protection needs pinning the
 * checked IP for the connection itself, which plain `fetch()` has no hook for; that's a
 * known residual gap, not something silently ignored.
 */

const VERIFICATION_PATH = "/.well-known/openglass-agent-verification.txt";
const FETCH_TIMEOUT_MS = 5000;
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

export function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 0) return false; // 0.0.0.0/8
  if (a >= 224) return false; // multicast/reserved (224.0.0.0/4 and above)
  return true;
}

export function isPublicIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return false; // loopback
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return false; // link-local fe80::/10
  if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // unique local fc00::/7
  if (lower.startsWith("::ffff:")) return isPublicIpv4(lower.slice("::ffff:".length)); // IPv4-mapped
  return true;
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

/** Fetches the well-known file and checks it contains the token on its own line (trimmed
 * whitespace tolerated). Never throws — a network error, timeout, non-200, an address that
 * resolves privately, or a missing token are all just "not verified yet". */
export async function checkDomainVerification(domain: string, token: string): Promise<boolean> {
  if (!(await resolvesToPublicAddress(domain))) return false;
  try {
    const res = await fetch(verificationFileUrl(domain), {
      redirect: "manual", // don't follow a redirect to a domain the agent doesn't control
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const reader = res.body?.getReader();
    if (!reader) return false;
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
    return text
      .split("\n")
      .map((line) => line.trim())
      .includes(token);
  } catch {
    return false;
  }
}
