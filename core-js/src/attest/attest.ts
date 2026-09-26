import { base64UrlEncode, canonicalize, canonicalizeToBytes, hex, sha256, sigInput, signEd25519, type AgentIdentity, type Signature } from "openglass-sdk";
import { evaluate } from "../policy/evaluate.js";
import type { Policy, PolicyEvent, RiskLevel } from "../policy/types.js";
import { signedRequest } from "./httpSign.js";
import type { AttestApiView, AttestationCloseStatement, AttestationOpen, AttestOptions, AttestResult } from "./types.js";
import { randomUlid } from "./ulid.js";

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const DEFAULT_BASE_URL = "https://openglass.glass";

async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw lastErr;
}

function signPurpose<T>(purpose: string, obj: T, identity: AgentIdentity): Signature {
  const digest = sha256(Buffer.from(canonicalize(obj), "utf8"));
  return { alg: "Ed25519", kid: identity.kid, sig: base64UrlEncode(signEd25519(sigInput(purpose, digest), identity.privateKey)) };
}

/**
 * The one primitive every integration calls: evaluate `event` against `policy`, and if
 * the risk meets `opts.minRisk` (default "high"), open a one-party attestation (SPEC
 * §12) recording the event and its verdict, then close it immediately — a single
 * witnessed record per risky action, requiring your own agent identity to already be
 * registered and claimed.
 *
 * Fails open by design: a network problem or an OpenGlass outage is retried
 * (`opts.retries`, default 3, exponential backoff) and then reported via `opts.onError`
 * — it never throws, so it never blocks whatever real action this event is describing.
 * That's the point of an integration kit: OpenGlass being down should never be the
 * reason your agent's actual work stops.
 */
export async function evaluateAndAttest(identity: AgentIdentity, policy: Policy, event: PolicyEvent, opts: AttestOptions = {}): Promise<AttestResult> {
  const verdict = evaluate(policy, event);
  const minRisk = opts.minRisk ?? "high";
  if (RISK_ORDER[verdict.risk] < RISK_ORDER[minRisk]) {
    return { attested: false, reason: "below_threshold", risk: verdict.risk, matches: verdict.matches };
  }

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const mode = opts.mode ?? "notary";
  const retries = opts.retries ?? 3;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const onError = opts.onError ?? ((err: unknown) => console.error("[openglass-core] attestation failed, continuing without one:", err));

  try {
    const attestationId = `att_${randomUlid()}`;
    const open: AttestationOpen = {
      v: 1,
      type: "openglass.attestation_open",
      attestationId,
      mode,
      purpose: verdict.matches.map((m) => m.id).join(", ") || "openglass-policy match",
      attestor: { agentId: identity.agentId!, kid: identity.kid, publicKey: base64UrlEncode(identity.publicKey) },
      createdAt: new Date().toISOString(),
    };
    const openSignature = signPurpose("attestation_open", open, identity);
    const { attestation } = await withRetry(
      () => signedRequest<{ attestation: AttestApiView }>(baseUrl, "POST", "/v1/attestations", { open, openSignature, idleTimeoutSec: opts.idleTimeoutSec }, identity, fetchImpl),
      retries,
    );

    const verdictPayload = { event, verdict };
    const payload = mode === "relay" ? verdictPayload : undefined;
    const payloadHash = hex(sha256(canonicalizeToBytes(verdictPayload)));
    const envelope = {
      v: 1 as const,
      type: "openglass.message" as const,
      sessionId: attestationId,
      seq: 1,
      prevHash: attestation.genesisHash,
      sender: { agentId: identity.agentId!, kid: identity.kid },
      contentType: "application/json",
      payloadHash,
      sentAt: new Date().toISOString(),
    };
    const hashBytes = sha256(Buffer.concat([Buffer.from(attestation.genesisHash, "hex"), Buffer.from(canonicalize(envelope), "utf8")]));
    const hash = hex(hashBytes);
    const signature: Signature = { alg: "Ed25519", kid: identity.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), identity.privateKey)) };
    const { head } = await withRetry(
      () => signedRequest<{ head: { seq: number; hash: string } }>(baseUrl, "POST", `/v1/attestations/${attestationId}/events`, { envelope, hash, signature, payload }, identity, fetchImpl),
      retries,
    );

    const statement: AttestationCloseStatement = { v: 1, type: "openglass.close", sessionId: attestationId, headSeq: head.seq, headHash: head.hash, closedAt: new Date().toISOString() };
    const closeSignature = signPurpose("close", statement, identity);
    await withRetry(() => signedRequest(baseUrl, "POST", `/v1/attestations/${attestationId}/close`, { statement, signature: closeSignature }, identity, fetchImpl), retries);

    return { attested: true, attestationId, risk: verdict.risk, matches: verdict.matches };
  } catch (error) {
    onError(error);
    return { attested: false, reason: "api_unreachable", risk: verdict.risk, matches: verdict.matches, error };
  }
}

/**
 * Convenience wrapper for wrapping a callback directly (mirroring `openglass-sdk`'s own
 * `witness()`): attests first — so the record exists even if `action` later throws — then
 * runs `action`. Most integrations (openglass-otel included) observe events after the
 * fact and call `evaluateAndAttest` directly instead; this is for the case where you're
 * intercepting a call before it happens.
 */
export async function witnessIfRisky<T>(
  identity: AgentIdentity,
  policy: Policy,
  event: PolicyEvent,
  action: () => Promise<T> | T,
  opts: AttestOptions = {},
): Promise<{ result: T; attestation: AttestResult }> {
  const attestation = await evaluateAndAttest(identity, policy, event, opts);
  const result = await action();
  return { result, attestation };
}
