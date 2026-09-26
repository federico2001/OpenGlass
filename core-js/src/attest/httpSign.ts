import { randomBytes } from "node:crypto";
import { base64UrlEncode, canonicalize, sha256, sigInput, signEd25519, type AgentIdentity } from "openglass-sdk";

export class OpenGlassApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: unknown,
  ) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body)}`);
    this.name = "OpenGlassApiError";
  }
}

export type FetchLike = typeof fetch;

/**
 * SPEC §4.1 signed-request headers, built from the crypto primitives `openglass-sdk`
 * already exports (Ed25519 signing, canonical JSON, sha256) — this file only adds the
 * thin fetch/header-building wrapper on top, which `openglass-sdk`'s own client doesn't
 * currently expose as a standalone function. `fetchImpl` is injectable so integrations
 * (and this package's own tests) can simulate the network without a real server.
 */
export async function signedRequest<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  body: unknown,
  identity: AgentIdentity,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const bodySha256 = Buffer.from(sha256(Buffer.from(bodyStr, "utf8"))).toString("hex");
  const timestamp = new Date().toISOString();
  const nonce = base64UrlEncode(randomBytes(16));
  const digest = sha256(Buffer.from(canonicalize({ method, path, timestamp, nonce, bodySha256 }), "utf8"));
  const sig = base64UrlEncode(signEd25519(sigInput("request", digest), identity.privateKey));

  const headers: Record<string, string> = {
    "og-key": identity.kid,
    "og-timestamp": timestamp,
    "og-nonce": nonce,
    "og-signature": sig,
  };
  if (identity.agentId) headers["og-agent"] = identity.agentId;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? bodyStr : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new OpenGlassApiError(method, path, res.status, json);
  return json as T;
}
