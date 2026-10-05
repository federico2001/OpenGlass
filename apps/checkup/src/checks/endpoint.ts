import { randomUUID } from "node:crypto";
import type { AttestedFetchResult, DirectFetcher, DirectFetchResult, FetchWitness } from "openglass-sdk";
import { endpointsOf, type Endpoint } from "../a2a.js";
import { NetError, safeFetch, type SafeResponse } from "../net.js";
import { clamp, quoteData, type CheckDeps, type Finding, type Section } from "./types.js";

const MAX_RESPONSE_BYTES = 256 * 1024;

export const PROBE_TEXT =
  "Hello. This is Agent Checkup by OpenGlass making one automated test request to confirm this agent " +
  "answers A2A messages. No action is needed; a short reply is enough.";

/** How checkEndpoint reaches an attestedFetch — a narrow structural type so this module
 * doesn't need to import AttestationRecorder itself; checkup.ts passes `recorder.attestedFetch.bind(recorder)`. */
export interface EndpointWitness {
  attestedFetch: (url: string, opts: { mode: CheckDeps["witnessMode"]; method?: "GET" | "POST"; body?: unknown; directFetch: DirectFetcher }) => Promise<AttestedFetchResult>;
}

export interface EndpointDetails {
  url: string | null;
  binding: string | null;
  protocolVersion: string | null;
  method: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  ok: boolean;
  /** What came back: "message", "task", "payment-required", "rpc-error", "http-error", "network-error". */
  outcome: string | null;
  error: string | null;
  rpcError: { code: number | null; message: string } | null;
  /** Whether OpenGlass itself independently witnessed this exchange (docs/SPEC.md §12.7) —
   * never set from a self-report, since the score above already reflects what actually came
   * back, witnessed or not. */
  witnessed: boolean;
  witnessReason: string | null;
}

export interface EndpointResult {
  section: Section<EndpointDetails>;
  /** The raw response, for the x402 check. Never echoed into the report. */
  response: SafeResponse | null;
  json: unknown;
}

const empty: EndpointDetails = {
  url: null, binding: null, protocolVersion: null, method: null, httpStatus: null, latencyMs: null,
  ok: false, outcome: null, error: null, rpcError: null, witnessed: false, witnessReason: null,
};

/** Sends exactly one benign message to the card's preferred JSON-RPC or HTTP+JSON
 * interface, in the wire format of the protocol version it declares. */
export async function checkEndpoint(card: Record<string, unknown> | null, deps: CheckDeps, witness?: EndpointWitness): Promise<EndpointResult> {
  if (!card) {
    return { response: null, json: null, section: { score: null, summary: "Not tested: there was no card to find the endpoint in.", findings: [], details: empty } };
  }
  const endpoints = endpointsOf(card);
  const endpoint = endpoints.find((e) => e.binding === "JSONRPC") ?? endpoints.find((e) => e.binding === "HTTP+JSON");
  if (!endpoint) {
    const onlyGrpc = endpoints.length > 0;
    return {
      response: null,
      json: null,
      section: {
        score: onlyGrpc ? null : 0,
        summary: onlyGrpc ? "Not tested: the card only lists gRPC interfaces." : "The card lists no endpoint URL.",
        findings: onlyGrpc ? [] : [{ severity: "high", fix: "List the agent's endpoint in supportedInterfaces (url, protocolBinding JSONRPC, protocolVersion)." }],
        details: empty,
      },
    };
  }

  const request = buildRequest(endpoint);
  const securityDeclared = hasSecurity(card);
  const details: EndpointDetails = { ...empty, url: request.url, binding: endpoint.binding, protocolVersion: endpoint.protocolVersion, method: request.method };
  let response: SafeResponse;
  try {
    const fetched = await runEndpointFetch(request, deps, witness);
    response = fetched.response;
    details.witnessed = fetched.witnessed;
    details.witnessReason = fetched.witnessReason;
  } catch (err) {
    const message = err instanceof NetError ? err.message : "request failed";
    return {
      response: null,
      json: null,
      section: {
        score: 0,
        summary: `No answer from ${request.url}: ${message}.`,
        findings: [{ severity: "high", fix: err instanceof NetError && err.code === "timeout" ? "Answer message/send within 10 seconds." : `Make the endpoint ${request.url} reachable over the public internet.` }],
        details: { ...details, outcome: "network-error", error: message },
      },
    };
  }

  details.httpStatus = response.status;
  details.latencyMs = response.latencyMs;
  let json: unknown = null;
  try {
    json = JSON.parse(response.body.toString("utf8"));
  } catch {
    /* handled below */
  }
  const findings: Finding[] = [];
  let score: number;
  let summary: string;

  if (response.status === 402) {
    details.ok = true;
    details.outcome = "payment-required";
    score = 100;
    summary = `${request.method} answered 402 Payment Required in ${response.latencyMs} ms.`;
  } else if ((response.status === 401 || response.status === 403) && securityDeclared) {
    details.outcome = "http-error";
    details.error = `HTTP ${response.status}`;
    score = 70;
    summary = `${request.method} needs authentication (HTTP ${response.status}), as the card declares.`;
  } else if (response.status < 200 || response.status >= 300) {
    details.outcome = "http-error";
    details.error = `HTTP ${response.status}`;
    score = 20;
    summary = `${request.method} to ${request.url} returned HTTP ${response.status}.`;
    findings.push({ severity: "high", fix: `Make ${request.url} accept ${request.method} (it returned HTTP ${response.status}).` });
  } else {
    const parsed = interpret(endpoint, json);
    details.outcome = parsed.outcome;
    details.rpcError = parsed.rpcError;
    if (parsed.outcome === "message" || parsed.outcome === "task" || parsed.outcome === "payment-required") {
      details.ok = true;
      score = 100;
      summary = `${request.method} answered with a ${parsed.outcome === "payment-required" ? "payment request" : parsed.outcome} in ${response.latencyMs} ms.`;
    } else if (parsed.outcome === "rpc-error") {
      score = 40;
      details.error = `JSON-RPC error ${parsed.rpcError?.code ?? "?"}`;
      summary = `${request.method} returned JSON-RPC error ${parsed.rpcError?.code ?? "?"}: "${quoteData(parsed.rpcError?.message)}".`;
      findings.push({
        severity: "high",
        fix: parsed.rpcError?.code === -32601 ? `Implement ${request.method}; the endpoint says the method doesn't exist.` : `Answer a plain text ${request.method} without an error.`,
      });
    } else {
      score = 25;
      details.error = "unrecognized response";
      summary = `${request.method} answered HTTP ${response.status}, but not with an A2A message or task.`;
      findings.push({ severity: "high", fix: `Return a ${endpoint.binding === "JSONRPC" ? "JSON-RPC result holding a" : ""} Message or Task from ${request.method}.`.replace("  ", " ") });
    }
  }

  if (details.ok && response.latencyMs > 3000) {
    score -= response.latencyMs > 8000 ? 30 : 15;
    findings.push({ severity: "low", fix: `Answer faster: the test message took ${(response.latencyMs / 1000).toFixed(1)} s.` });
  }
  if (!request.url.startsWith("https://")) {
    score -= 20;
    findings.push({ severity: "high", fix: "Serve the agent over HTTPS with a valid certificate." });
  }
  return { response, json, section: { score: clamp(score), summary, findings, details } };
}

/** Runs the one real probe request, witnessed per `deps.witnessMode` (docs/SPEC.md §12.7)
 * when `witness` is given. `"primary"` scores off OpenGlass's own witnessed response;
 * every other case — `"shadow"`, `"off"`, no `witness` at all, or `"primary"`'s own
 * fallback — scores off the direct `safeFetch` response, unchanged from before witnessing
 * existed. The one case this never does is fire `direct()` twice: `"primary"` mode's
 * target-unreachable outcome (OpenGlass already tried and the target didn't answer) is
 * surfaced as the same network-error the caller already handles, not retried. */
async function runEndpointFetch(
  request: BuiltRequest,
  deps: CheckDeps,
  witness: EndpointWitness | undefined,
): Promise<{ response: SafeResponse; witnessed: boolean; witnessReason: string | null }> {
  const started = performance.now();
  const direct: DirectFetcher = async () => {
    const r = await safeFetch(request.url, { method: "POST", headers: request.headers, body: request.body, maxBytes: MAX_RESPONSE_BYTES }, deps.net);
    return { status: r.status, headers: r.headers, body: r.body };
  };

  if (!witness) {
    const d = await direct(request.url, { method: "POST" });
    return { response: toSafeResponse(d, request.url, Math.round(performance.now() - started)), witnessed: false, witnessReason: null };
  }

  const result = await witness.attestedFetch(request.url, { mode: deps.witnessMode, method: "POST", body: JSON.parse(request.body), directFetch: direct });

  if (result.witnessed && deps.witnessMode === "primary" && result.witness) {
    return { response: responseFromWitness(result.witness, request.url), witnessed: true, witnessReason: result.reason };
  }
  if (!result.direct) {
    // "primary" mode, and OpenGlass already witnessed that the target itself didn't answer.
    throw new NetError("network", result.reason);
  }
  return { response: toSafeResponse(result.direct, request.url, Math.round(performance.now() - started)), witnessed: result.witnessed, witnessReason: result.reason };
}

function toSafeResponse(d: DirectFetchResult, url: string, latencyMs: number): SafeResponse {
  return { status: d.status, headers: d.headers, url, redirects: [], body: d.body, latencyMs };
}

/** Rebuilds a SafeResponse-shaped value from OpenGlass's own witness, for "primary" mode's
 * scoring — bodyText is null only when the content type isn't text-ish (never the case for
 * a JSON-RPC reply) or the response was truncated past the witness cap (65536 bytes vs.
 * this probe's own 262144 — unlikely for a short probe reply, but if it happens, an empty
 * body here degrades to the same "unrecognized response" scoring a malformed reply gets,
 * not a crash). */
function responseFromWitness(witness: FetchWitness, url: string): SafeResponse {
  return {
    status: witness.response.status,
    headers: new Headers(witness.response.headers),
    url,
    redirects: [],
    body: Buffer.from(witness.response.bodyText ?? "", "utf8"),
    latencyMs: Math.max(0, new Date(witness.fetchedAt).getTime() - new Date(witness.requestedAt).getTime()),
  };
}

interface BuiltRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function isLegacy(version: string): boolean {
  return /^0\./.test(version.trim());
}

export function buildRequest(endpoint: Endpoint): BuiltRequest {
  const legacy = isLegacy(endpoint.protocolVersion);
  const messageId = randomUUID();
  const message = legacy
    ? { kind: "message", messageId, role: "user", parts: [{ kind: "text", text: PROBE_TEXT }] }
    : { messageId, role: "ROLE_USER", parts: [{ text: PROBE_TEXT, mediaType: "text/plain" }] };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (!legacy) headers["a2a-version"] = endpoint.protocolVersion;

  if (endpoint.binding === "HTTP+JSON") {
    const base = endpoint.url.replace(/\/+$/, "");
    return { url: `${base}${legacy ? "/v1/message:send" : "/message:send"}`, method: legacy ? "message/send" : "SendMessage", headers, body: JSON.stringify({ message }) };
  }
  const method = legacy ? "message/send" : "SendMessage";
  return { url: endpoint.url, method, headers, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { message } }) };
}

function interpret(endpoint: Endpoint, json: unknown): { outcome: string; rpcError: EndpointDetails["rpcError"] } {
  if (!json || typeof json !== "object") return { outcome: "unrecognized", rpcError: null };
  const body = json as Record<string, unknown>;
  if (endpoint.binding === "JSONRPC") {
    if (body.error && typeof body.error === "object") {
      const e = body.error as { code?: unknown; message?: unknown };
      return { outcome: "rpc-error", rpcError: { code: typeof e.code === "number" ? e.code : null, message: String(e.message ?? "") } };
    }
    if (!("result" in body)) return { outcome: "unrecognized", rpcError: null };
    return { outcome: kindOf(body.result), rpcError: null };
  }
  return { outcome: kindOf(body), rpcError: null };
}

/** Message or Task, in either wire format: 0.3 tags results with `kind`; 1.0 wraps them
 * as `{ message }` or `{ task }`. */
export function kindOf(result: unknown): string {
  if (!result || typeof result !== "object") return "unrecognized";
  const r = result as Record<string, unknown>;
  const task = (r.kind === "task" ? r : r.task) as Record<string, unknown> | undefined;
  if (task && typeof task === "object") return paymentRequiredIn(task) ? "payment-required" : "task";
  if (r.kind === "message" || (r.message && typeof r.message === "object")) return "message";
  if (Array.isArray(r.parts) && typeof r.messageId === "string") return "message";
  return "unrecognized";
}

/** The A2A x402 extension signals payment in-band: a task whose status metadata says
 * `x402.payment.status: "payment-required"`. */
export function paymentRequiredIn(task: Record<string, unknown>): unknown {
  const status = task.status as { message?: { metadata?: Record<string, unknown> } } | undefined;
  const meta = { ...((task.metadata as Record<string, unknown>) ?? {}), ...(status?.message?.metadata ?? {}) };
  return meta["x402.payment.status"] === "payment-required" ? (meta["x402.payment.required"] ?? {}) : null;
}

function hasSecurity(card: Record<string, unknown>): boolean {
  const reqs = (card.securityRequirements ?? card.security) as unknown;
  return Array.isArray(reqs) && reqs.length > 0;
}
