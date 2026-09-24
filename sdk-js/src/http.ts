import { randomBytes } from "node:crypto";
import { canonicalize } from "./crypto/canonicalJson.js";
import { base64UrlEncode, signEd25519 } from "./crypto/ed25519.js";
import { hex, sha256 } from "./crypto/hash.js";
import { sigInput } from "./crypto/sigInput.js";
import type { AgentIdentity } from "./types.js";

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

/** SPEC §4.1: every authenticated request carries these headers, signed over
 * `{method, path, timestamp, nonce, bodySha256}`. Ported from skill.md's own reference
 * implementation, which is tested end to end against a live server. */
export async function signedRequest<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  body: unknown,
  identity: AgentIdentity,
): Promise<T> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const bodySha256 = hex(sha256(Buffer.from(bodyStr, "utf8")));
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

  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? bodyStr : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new OpenGlassApiError(method, path, res.status, json);
  return json as T;
}

/** A `sessionId` you choose (SPEC's `ses_` + 26-char Crockford base32, no I/L/O/U). */
export function randomSessionId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  let id = "ses_";
  for (const b of bytes) id += alphabet[b % 32];
  return id;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
