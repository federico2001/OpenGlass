import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

/**
 * Outbound requests to a target agent (SSRF guard). Every connection resolves the host
 * itself, refuses it if ANY resolved address is private, loopback, link-local, CGNAT,
 * multicast or reserved, and connects to the address it just checked (the check and the
 * connection use the same lookup, so a DNS-rebinding answer can't slip in between).
 * Redirects are never followed automatically: each hop is re-checked the same way, up to
 * MAX_REDIRECTS. Bodies are read under a byte cap and the whole request, body included,
 * runs under one timeout.
 */

export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** True for an address a request to a third-party agent may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(address, "ipv4");
  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses carry a v4 address.
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return isPublicAddress(embedded[1]!);
  if (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b::")) return false;
  return !blocked.check(address, "ipv6");
}

export type NetErrorCode =
  | "bad_url"
  | "blocked_address"
  | "dns_failed"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "tls_failed"
  | "network";

export class NetError extends Error {
  constructor(
    public code: NetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NetError";
  }
}

export interface NetPolicy {
  /** Only for tests against a local fake target. Never set in a deployment. */
  allowPrivateAddresses: boolean;
  userAgent: string;
  /** Tests only: overrides the address rule above (e.g. allow 127.0.0.1, block the rest). */
  isAllowed?: (address: string) => boolean;
  /** Tests only: defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Resolves every address for `hostname` and refuses the lot if any one is non-public. */
export async function resolvePublic(hostname: string, policy: NetPolicy): Promise<{ address: string; family: number }[]> {
  const host = bareHost(hostname);
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await dnsLookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new NetError("dns_failed", `${host} does not resolve (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  if (addresses.length === 0) throw new NetError("dns_failed", `${host} has no addresses`);
  const allowed = policy.isAllowed ?? ((address: string) => policy.allowPrivateAddresses || isPublicAddress(address));
  if (addresses.some((a) => !allowed(a.address))) throw new NetError("blocked_address", `${host} resolves to a non-public address`);
  return addresses;
}

function pinnedLookup(policy: NetPolicy): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolvePublic(hostname, policy).then(
      (addresses) => {
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err) => callback(err),
    );
  }) as LookupFunction;
}

const agents = new WeakMap<NetPolicy, Dispatcher>();
function dispatcherFor(policy: NetPolicy): Dispatcher {
  let agent = agents.get(policy);
  if (!agent) {
    agent = new Agent({ connect: { lookup: pinnedLookup(policy), timeout: policy.timeoutMs ?? REQUEST_TIMEOUT_MS }, keepAliveTimeout: 1000 });
    agents.set(policy, agent);
  }
  return agent;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  /** The URL that finally answered, after any redirects. */
  url: string;
  redirects: string[];
  body: Buffer;
  latencyMs: number;
}

export interface SafeRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  maxBytes: number;
  /** Follow (re-checked) redirects. Off for POSTs, which shouldn't be replayed elsewhere. */
  followRedirects?: boolean;
}

function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetError("bad_url", "not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new NetError("bad_url", "only http and https URLs are checked");
  if (url.username || url.password) throw new NetError("bad_url", "URLs with credentials are not checked");
  return url;
}

export async function safeFetch(rawUrl: string, req: SafeRequest, policy: NetPolicy): Promise<SafeResponse> {
  const started = performance.now();
  const timeoutMs = policy.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const redirects: string[] = [];
  let url = checkUrl(rawUrl);
  try {
    for (;;) {
      // Fail fast (and with a clear code) before connecting; the dispatcher re-checks.
      await resolvePublic(url.hostname, policy);
      const res = await undiciFetch(url, {
        method: req.method ?? "GET",
        headers: { "user-agent": policy.userAgent, ...req.headers },
        body: req.body,
        redirect: "manual",
        signal,
        dispatcher: dispatcherFor(policy),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location && req.followRedirects) {
        await res.body?.cancel();
        if (redirects.length >= MAX_REDIRECTS) throw new NetError("too_many_redirects", `more than ${MAX_REDIRECTS} redirects`);
        url = checkUrl(new URL(location, url).toString());
        redirects.push(url.toString());
        continue;
      }
      const body = await readCapped(res.body as ReadableStream<Uint8Array> | null, req.maxBytes);
      return { status: res.status, headers: res.headers as unknown as Headers, url: url.toString(), redirects, body, latencyMs: Math.round(performance.now() - started) };
    }
  } catch (err) {
    throw toNetError(err, signal, timeoutMs);
  }
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new NetError("too_large", `response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function toNetError(err: unknown, signal: AbortSignal, timeoutMs: number): NetError {
  if (err instanceof NetError) return err;
  if (signal.aborted) return new NetError("timeout", `no complete response within ${timeoutMs / 1000} seconds`);
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof NetError) return cause;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? (err as NodeJS.ErrnoException)?.code;
  if (code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return new NetError("tls_failed", `TLS error (${code})`);
  return new NetError("network", code ? `connection failed (${code})` : "connection failed");
}

export interface TlsFacts {
  valid: boolean;
  error: string | null;
  validTo: string | null;
  daysRemaining: number | null;
  issuer: string | null;
}

/** Opens a TLS connection to the checked address with full certificate verification. */
export async function inspectTls(hostname: string, port: number, policy: NetPolicy): Promise<TlsFacts> {
  const [first] = await resolvePublic(hostname, policy);
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: first!.address, port, servername: bareHost(hostname), rejectUnauthorized: true, timeout: policy.timeoutMs ?? REQUEST_TIMEOUT_MS });
    const done = (facts: TlsFacts) => {
      socket.destroy();
      resolve(facts);
    };
    socket.once("secureConnect", () => {
      const cert: PeerCertificate = socket.getPeerCertificate();
      const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
      done({
        valid: socket.authorized,
        error: socket.authorized ? null : String(socket.authorizationError ?? "unauthorized"),
        validTo: validTo?.toISOString() ?? null,
        daysRemaining: validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null,
        issuer: typeof cert.issuer?.O === "string" ? cert.issuer.O : (cert.issuer?.CN as string | undefined) ?? null,
      });
    });
    socket.once("timeout", () => done({ valid: false, error: "timeout", validTo: null, daysRemaining: null, issuer: null }));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done({ valid: false, error: err.code ?? err.message, validTo: null, daysRemaining: null, issuer: null }),
    );
  });
}
