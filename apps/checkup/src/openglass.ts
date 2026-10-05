import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  OpenGlassApiError,
  OpenGlassClient,
  base64UrlEncode,
  canonicalize,
  hex,
  sha256,
  sigInput,
  signEd25519,
  type AgentIdentity,
  type AttestedFetchOptions,
  type AttestedFetchResult,
  type LookupResult,
  type RecordBundle,
} from "openglass-sdk";

/**
 * Everything Agent Checkup does on OpenGlass, as an ordinary agent using the published
 * SDK: register (once), get claimed by its owner (a human step), record each checkup as a
 * one-party attestation, look targets up, and list unregistered ones as unclaimed profiles.
 * Nothing here reaches into OpenGlass's database; it only uses the public API.
 */

export const CHECKUP_AGENT_NAME = "Agent Checkup by OpenGlass";
const SOFTWARE = "agent-checkup/1.0.0";

export type AgentStatus = "unregistered" | "unclaimed" | "active" | "suspended" | "error";

export interface OpenGlassOptions {
  /** Where to call the API (inside Docker: http://api:3000). */
  apiUrl: string;
  /** The public OpenGlass origin, for links people open (https://openglass.glass). */
  publicUrl: string;
  /** This service's own public URL, registered as the agent's homepage. */
  checkupUrl: string;
  /** 32-byte Ed25519 private key. Kept only in this process. */
  privateKey: Uint8Array;
}

export interface UnclaimedProfile {
  domain: string;
  claimed: boolean;
  claimUrl: string;
  profileUrl: string;
}

export class OpenGlassLink {
  readonly client: OpenGlassClient;
  status: AgentStatus = "unregistered";
  agentId: string | null = null;
  /** The latest claim link, shown on the admin page until the owner claims the agent. */
  claimUrl: string | null = null;
  lastError: string | null = null;

  constructor(readonly opts: OpenGlassOptions) {
    this.client = new OpenGlassClient({ baseUrl: opts.apiUrl });
  }

  get publicKey(): string {
    return base64UrlEncode(ed25519.getPublicKey(this.opts.privateKey));
  }

  /** Finds this service's agent by its public key, or registers it. Never throws: the
   * checkup runs without OpenGlass (reports just carry no record link) until this works. */
  async init(): Promise<void> {
    try {
      const publicKey = ed25519.getPublicKey(this.opts.privateKey);
      const found = await this.client.lookup({ publicKey: base64UrlEncode(publicKey) });
      if (found.registered) {
        // Lookup gives the agent id but not the key id that signed requests need.
        const agent = await this.client.getAgent(found.agentId);
        const key = agent.keys.find((k) => k.publicKey === base64UrlEncode(publicKey) && !k.revokedAt);
        if (!key) throw new Error("this key is registered but revoked");
        this.client.identity = { agentId: agent.id, kid: key.kid, privateKey: this.opts.privateKey, publicKey };
        this.agentId = agent.id;
        await this.refreshStatus();
      } else {
        this.client.identity = { kid: "new", privateKey: this.opts.privateKey, publicKey };
        const { agent, claim } = await this.client.registerAgent({
          name: CHECKUP_AGENT_NAME,
          description:
            "Checks A2A agents from the outside (card, endpoint, x402, identity) and records each checkup on OpenGlass as a one-party attestation.",
          meta: { homepage: this.opts.checkupUrl, software: SOFTWARE },
        });
        this.agentId = agent.id;
        this.status = "unclaimed";
        this.claimUrl = claim.url;
      }
      this.lastError = null;
    } catch (err) {
      this.status = "error";
      this.lastError = errorText(err);
    }
  }

  async refreshStatus(): Promise<AgentStatus> {
    if (!this.client.identity?.agentId) return this.status;
    try {
      const me = await this.client.me();
      this.status = me.status as AgentStatus;
      if (this.status === "active") this.claimUrl = null;
      this.lastError = null;
    } catch (err) {
      this.lastError = errorText(err);
    }
    return this.status;
  }

  /** A fresh claim link (they expire after 24 hours). The published SDK has no method for
   * `POST /v1/agents/me/claim-token`, so this signs the request itself. */
  async newClaimLink(): Promise<string | null> {
    try {
      const res = await this.signed<{ claim: { url: string } }>("POST", "/v1/agents/me/claim-token");
      this.claimUrl = res.claim.url;
      return this.claimUrl;
    } catch (err) {
      this.lastError = errorText(err);
      return null;
    }
  }

  get canRecord(): boolean {
    return this.status === "active" && !!this.client.identity?.agentId;
  }

  /** Opens a one-party attestation for one checkup. `shared` visibility: the record is the
   * checkup's own, and keeping its content in plaintext is what lets the bundle we hand out
   * verify offline. */
  startRecord(purpose: string): AttestationRecorder {
    return new AttestationRecorder(this, purpose);
  }

  async lookup(domain: string): Promise<LookupResult & { unclaimedProfile?: UnclaimedProfile | null }> {
    return this.client.lookup({ domain });
  }

  /** `POST /v1/profiles/unclaimed` (docs/SPEC.md §16). Not in the published SDK. */
  async listUnclaimed(domain: string): Promise<{ profile: UnclaimedProfile | null; registeredAgentId: string | null }> {
    try {
      const res = await this.signed<{ profile: UnclaimedProfile }>("POST", "/v1/profiles/unclaimed", { domain });
      return { profile: res.profile, registeredAgentId: null };
    } catch (err) {
      const body = err instanceof OpenGlassApiError ? (err.body as { error?: { code?: string; details?: { agentId?: string } } }) : null;
      if (body?.error?.code === "already_registered") return { profile: null, registeredAgentId: body.error.details?.agentId ?? null };
      throw err;
    }
  }

  /** Public read of an unclaimed profile; null when there is none. */
  async getUnclaimed(domain: string): Promise<UnclaimedProfile | null> {
    const res = await fetch(`${this.opts.apiUrl}/v1/profiles/unclaimed/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`profile read failed: HTTP ${res.status}`);
    return ((await res.json()) as { profile: UnclaimedProfile }).profile;
  }

  /** The record id once the worker has issued it, else null. */
  async recordIdFor(attestationId: string): Promise<string | null> {
    const attestation = await this.client.getAttestation(attestationId);
    return attestation.status === "closed" && attestation.recordId ? attestation.recordId : null;
  }

  async bundle(recordId: string): Promise<RecordBundle> {
    return this.client.getRecordBundle(recordId);
  }

  async signed<T>(method: string, path: string, body?: unknown): Promise<T> {
    const identity = this.client.identity;
    if (!identity?.agentId) throw new Error("not registered yet");
    return signedRequest<T>(this.opts.apiUrl, method, path, body, identity);
  }
}

/** Collects one checkup's events. Every call is best-effort: if OpenGlass is unreachable,
 * or the agent isn't claimed yet, the checkup still runs and the report says so. */
export class AttestationRecorder {
  attestationId: string | null = null;
  error: string | null = null;
  private opened: Promise<void>;
  private chain: Promise<void>;

  constructor(
    private link: OpenGlassLink,
    purpose: string,
  ) {
    this.opened = link.canRecord
      ? link.client
          .openAttestation({ purpose, visibility: "shared", idleTimeoutSec: 600 })
          .then(({ attestation }) => {
            this.attestationId = attestation.id;
          })
          .catch((err) => {
            this.error = errorText(err);
          })
      : Promise.resolve().then(() => {
          this.error = link.status === "unclaimed" ? "the checkup agent isn't claimed on OpenGlass yet" : (link.lastError ?? "OpenGlass is unavailable");
        });
    this.chain = this.opened;
  }

  /** Queues one event; events are appended in call order. */
  add(payload: Record<string, unknown>): void {
    this.chain = this.chain.then(async () => {
      if (!this.attestationId || this.error) return;
      try {
        await this.link.client.sendAttestationEvent(this.attestationId, payload);
      } catch (err) {
        this.error = errorText(err);
      }
    });
  }

  /** A fetch to a third party, witnessed per `opts.mode` (docs/SPEC.md §12.7) once the
   * attestation is ready — or, if recording never came up (not claimed yet, OpenGlass
   * unreachable), falls straight to `opts.directFetch`, unwitnessed, same as every other
   * best-effort call this class makes. Doesn't wait for queued `add()` events: the fetch
   * itself only needs the attestation to exist, not to be caught up. */
  async attestedFetch(url: string, opts: AttestedFetchOptions = {}): Promise<AttestedFetchResult> {
    await this.opened;
    return this.link.client.attestedFetch(this.error ? null : this.attestationId, url, opts);
  }

  /** Waits for every queued event, then closes. Returns the attestation id if all of it
   * was recorded. */
  async close(): Promise<string | null> {
    await this.chain;
    if (!this.attestationId || this.error) return null;
    try {
      await this.link.client.closeAttestation(this.attestationId);
      return this.attestationId;
    } catch (err) {
      this.error = errorText(err);
      return null;
    }
  }
}

export function contentHash(value: unknown): string {
  return hex(sha256(Buffer.from(canonicalize(value), "utf8")));
}

/** SPEC §4.1 request signing. The published SDK signs only the routes it wraps and doesn't
 * export its signer, so this mirrors it using the SDK's exported primitives. */
async function signedRequest<T>(baseUrl: string, method: string, path: string, body: unknown, identity: AgentIdentity): Promise<T> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const bodySha256 = hex(sha256(Buffer.from(bodyStr, "utf8")));
  const timestamp = new Date().toISOString();
  const nonce = base64UrlEncode(randomBytes(16));
  const digest = sha256(Buffer.from(canonicalize({ method, path, timestamp, nonce, bodySha256 }), "utf8"));
  const headers: Record<string, string> = {
    "og-agent": identity.agentId!,
    "og-key": identity.kid,
    "og-timestamp": timestamp,
    "og-nonce": nonce,
    "og-signature": base64UrlEncode(signEd25519(sigInput("request", digest), identity.privateKey)),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? bodyStr : undefined, signal: AbortSignal.timeout(10_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new OpenGlassApiError(method, path, res.status, json);
  return json as T;
}

function errorText(err: unknown): string {
  if (err instanceof OpenGlassApiError) {
    const code = (err.body as { error?: { code?: string } } | null)?.error?.code;
    return `${err.method} ${err.path} → ${err.status}${code ? ` ${code}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}
