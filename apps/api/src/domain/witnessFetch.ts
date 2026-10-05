import { createHash } from "node:crypto";
import { isBareHostname } from "./lookup.js";
import { resolvesToPublicAddress } from "./domainVerification.js";

/**
 * The platform fetching a URL itself and recording exactly what came back — for the
 * common case where the other side of an attestation isn't an OpenGlass agent at all, so
 * there's no key to sign anything and nothing for the attestor to self-report that anyone
 * else can check. This only proves the response came from a TLS session with that domain
 * at that moment (and whatever its certificate says); it says nothing about who operates
 * the server. Same SSRF guard as domainVerification.ts/lookup.ts: resolve the hostname
 * first and refuse anything that isn't a public address, never follow a redirect, and cap
 * how much of the response is read.
 *
 * `POST` carries a request body — always JSON (never a caller-chosen content type or
 * arbitrary headers), already serialized and size-checked by the caller
 * (appendFetchWitness.ts) before it ever reaches here, so this module only ever does the
 * actual network I/O.
 */

const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 65_536; // a web page or API response, not a file transfer
/** A JSON-RPC request body (e.g. an A2A message/send envelope), not a file upload. */
export const MAX_REQUEST_BODY_BYTES = 65_536;
/** Response headers worth keeping — never Set-Cookie or anything else that could carry a
 * credential or session detail belonging to the target server. `payment-required` is x402
 * v2's own public payment-terms header (base64 JSON, same data a 402 body would carry in
 * v1) — not a credential, and a caller like Agent Checkup relies on it to score x402. */
const CAPTURED_RESPONSE_HEADERS = ["content-type", "date", "server", "etag", "last-modified", "content-length", "payment-required"];
const TEXT_CONTENT_TYPE = /^(text\/|application\/(json|xml|[\w.+-]*\+(json|xml))\b)/i;

export interface WitnessFetchResponse {
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  bodySha256: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  bodyText: string | null;
}

export type WitnessFetchResult = { ok: true; response: WitnessFetchResponse } | { ok: false; reason: string };

export interface WitnessFetchRequest {
  method: "GET" | "POST";
  /** Canonical JSON bytes, already serialized and capped by the caller; absent for GET. */
  body?: Buffer;
}

/** Fetches a (pre-validated, https-only, SSRF-checked-by-the-caller) URL and reports what
 * came back, or why it couldn't. Injectable on `ServerDeps` so tests can fake the network
 * call instead of standing up a real public HTTPS server. */
export type WitnessFetcher = (url: URL, request: WitnessFetchRequest) => Promise<WitnessFetchResult>;

/** `https:`, a real DNS name (not an IP literal), default port, no embedded credentials —
 * the same shape `profiles.ts`'s `parseCardUrl` requires of an agent-supplied URL. */
export function parseWitnessUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
    return isBareHostname(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

export async function performWitnessFetch(url: URL, request: WitnessFetchRequest): Promise<WitnessFetchResult> {
  if (!(await resolvesToPublicAddress(url.hostname))) return { ok: false, reason: "URL does not resolve to a public address" };
  return captureHttpResponse(url, request);
}

/** The actual fetch-and-capture, with no SSRF guard of its own — callers that reach this
 * (performWitnessFetch, above) have already checked the hostname. Split out and exported
 * so it can be unit-tested directly against a local test server, which the guard above
 * would otherwise always refuse (loopback is never a public address). */
export async function captureHttpResponse(url: URL, request: WitnessFetchRequest): Promise<WitnessFetchResult> {
  let res: Response;
  try {
    res = await fetch(url.href, {
      method: request.method,
      headers: request.body ? { "content-type": "application/json" } : {},
      body: request.body?.toString("utf8"),
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "The request failed or timed out" };
  }

  const headers: Record<string, string> = {};
  for (const name of CAPTURED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const contentType = res.headers.get("content-type");

  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > MAX_RESPONSE_BYTES) {
        chunks.push(value.subarray(0, MAX_RESPONSE_BYTES - received));
        received = MAX_RESPONSE_BYTES;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  }
  const bytes = Buffer.concat(chunks);
  const bodySha256 = createHash("sha256").update(bytes).digest("hex");
  const bodyText = contentType && TEXT_CONTENT_TYPE.test(contentType) ? bytes.toString("utf8") : null;

  return {
    ok: true,
    response: { status: res.status, headers, contentType, bodySha256, bodyBytes: bytes.byteLength, bodyTruncated: truncated, bodyText },
  };
}
