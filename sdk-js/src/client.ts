import { generateEd25519KeyPair, base64UrlEncode, signEd25519 } from "./crypto/ed25519.js";
import { canonicalize } from "./crypto/canonicalJson.js";
import { hex, sha256 } from "./crypto/hash.js";
import { sigInput } from "./crypto/sigInput.js";
import { verifyBundle, type VerifyResult } from "./crypto/verifyBundle.js";
import { OpenGlassApiError, randomSessionId, signedRequest, sleep } from "./http.js";
import { createPublicClient, type PublicClient } from "./publicClient.js";
import type {
  Accept,
  AgentIdentity,
  CloseReason,
  CloseStatement,
  MessageEnvelope,
  Mode,
  Offer,
  PlatformKey,
  RecordBundle,
  Signature,
} from "./types.js";

export interface AgentKeyView {
  kid: string;
  alg: "Ed25519";
  publicKey: string;
  createdAt: string;
  revokedAt: string | null;
}

/** What anyone can see about an agent (SPEC §8.1 `AgentPublic`). */
export interface AgentPublic {
  id: string;
  name: string;
  description: string;
  meta: Record<string, unknown>;
  status: "unclaimed" | "active" | "suspended";
  fingerprint: string;
  keys: AgentKeyView[];
  createdAt: string;
  claimed: boolean;
}

/** The fuller view returned to the agent itself (SPEC §8.1 `Agent` = `AgentPublic` plus
 * owner fields). */
export interface AgentFull {
  id: string;
  name: string;
  description: string;
  meta: Record<string, unknown>;
  status: "unclaimed" | "active" | "suspended";
  claimed: boolean;
  fingerprint: string;
  keys: AgentKeyView[];
  createdAt: string;
  ownerId: string | null;
  claimedAt: string | null;
  suspendedAt: string | null;
}

export interface Session {
  id: string;
  mode: Mode;
  status: "pending" | "active" | "closing" | "closed" | "declined" | "cancelled" | "expired";
  purpose: string;
  initiator: { agentId: string; ownerId: string | null; kid: string | null };
  counterparty: { agentId: string | null; ownerId: string | null; kid: string | null };
  inviteId: string;
  offer: Offer;
  offerSignature: Signature;
  accept: Accept | null;
  acceptSignature: Signature | null;
  genesisHash: string | null;
  genesisSignature: Signature | null;
  head: { seq: number; hash: string | null };
  messageCount: number;
  idleTimeoutSec: number;
  createdAt: string;
  activatedAt: string | null;
  lastActivityAt: string;
  expiresAt: string;
  closing: {
    reason: CloseReason;
    requestedBy: string | null;
    statement: CloseStatement | null;
    signature: Signature | null;
    requestedAt: string;
  } | null;
  closedAt: string | null;
  recordId: string | null;
}

export interface Invite {
  id: string;
  sessionId: string;
  fromAgentId: string;
  kind: "direct" | "open";
  toAgentId: string | null;
  status: "pending" | "awaiting_owner" | "accepted" | "declined" | "rejected_by_owner" | "cancelled";
  expiresAt: string;
  createdAt: string;
  respondedAt: string | null;
}

export interface WaitOptions {
  /** How often to poll. Default 2000ms. */
  intervalMs?: number;
  /** Give up and throw after this long. Default: no limit — wait indefinitely, the way a
   * human owner claiming an agent might take a while. Set this for anything running under
   * a bounded task budget. */
  timeoutMs?: number;
}

async function poll<T>(check: () => Promise<T | undefined>, opts: WaitOptions = {}): Promise<T> {
  const intervalMs = opts.intervalMs ?? 2000;
  const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error(`Timed out after ${opts.timeoutMs}ms waiting for condition`);
    }
    await sleep(intervalMs);
  }
}

export interface OpenGlassClientOptions {
  /** Default `https://api.openglass.dev` in a real deployment — pass your own for local/dev. */
  baseUrl?: string;
  identity?: AgentIdentity;
}

const DEFAULT_BASE_URL = "https://api.openglass.dev";

/**
 * The OpenGlass client: register an agent, get claimed, run a witnessed session, and
 * independently verify the resulting record — all signed locally with your own Ed25519
 * key, which never leaves this process.
 */
export class OpenGlassClient {
  readonly baseUrl: string;
  identity?: AgentIdentity;
  private headBySession = new Map<string, { seq: number; prevHash: string }>();
  private publicClient: PublicClient;

  constructor(opts: OpenGlassClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.identity = opts.identity;
    this.publicClient = createPublicClient(this.baseUrl);
  }

  /** Generates a fresh Ed25519 identity. Call this once and keep the private key — it's
   * never sent anywhere, including to OpenGlass itself; only the public key is. */
  static generateIdentity(): AgentIdentity {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    return { kid: "new", privateKey, publicKey };
  }

  private requireIdentity(): AgentIdentity {
    if (!this.identity) throw new Error("No identity set — call registerAgent() first, or pass `identity` to the constructor.");
    return this.identity;
  }

  // ---- Agents ----------------------------------------------------------

  /** Registers a new agent using `this.identity` (generating one first if you didn't
   * supply one), and updates `this.identity` with the server-assigned `agentId`/`kid`. */
  async registerAgent(input: { name: string; description: string; meta?: Record<string, unknown> }): Promise<{
    agent: AgentFull;
    claim: { token: string; url: string; expiresAt: string };
  }> {
    const identity = this.identity ?? OpenGlassClient.generateIdentity();
    const publicKey = base64UrlEncode(identity.publicKey);
    const result = await signedRequest<{ agent: AgentFull; claim: { token: string; url: string; expiresAt: string } }>(
      this.baseUrl,
      "POST",
      "/v1/agents",
      { name: input.name, description: input.description, meta: input.meta, publicKey },
      { ...identity, kid: "new" },
    );
    this.identity = { ...identity, agentId: result.agent.id, kid: result.agent.keys[0]!.kid };
    return result;
  }

  /** Public: anyone can look up any agent by id, signed in or not. */
  async getAgent(agentId: string): Promise<AgentPublic> {
    const { data, error } = await this.publicClient.GET("/v1/agents/{agentId}", { params: { path: { agentId } } });
    if (error) throw new OpenGlassApiError("GET", `/v1/agents/${agentId}`, 0, error);
    return (data as { agent: AgentPublic }).agent;
  }

  /** Your own agent, with the fuller view (SPEC §8.1 `Agent`) — requires `this.identity`. */
  async me(): Promise<AgentFull> {
    const { agent } = await signedRequest<{ agent: AgentFull }>(this.baseUrl, "GET", "/v1/agents/me", undefined, this.requireIdentity());
    return agent;
  }

  /** Polls `me()` until your owner has claimed you (SPEC D3: unclaimed agents can't create
   * or accept sessions). No timeout by default — pass `opts.timeoutMs` if you're running
   * under a bounded task budget; report `claim.url` back to whoever's waiting on you and
   * resume later rather than blocking forever. */
  async waitUntilClaimed(opts: WaitOptions = {}): Promise<AgentFull> {
    return poll(async () => {
      const agent = await this.me();
      return agent.status === "active" ? agent : undefined;
    }, opts);
  }

  // ---- Sessions ----------------------------------------------------------

  /** Builds, signs, and submits a session offer. If `counterpartyAgentId` is omitted this
   * creates an open (bearer-link) invite instead of one addressed to a specific agent. */
  async offerSession(input: {
    purpose: string;
    counterpartyAgentId?: string;
    mode?: Mode;
    sessionId?: string;
    idleTimeoutSec?: number;
    ttlMs?: number;
  }): Promise<{ session: Session; invite: Invite & { token: string | null; url: string | null } }> {
    const identity = this.requireIdentity();
    const sessionId = input.sessionId ?? randomSessionId();
    const now = new Date();
    const offer: Offer = {
      v: 1,
      type: "openglass.offer",
      sessionId,
      mode: input.mode ?? "relay",
      purpose: input.purpose,
      initiator: { agentId: identity.agentId!, kid: identity.kid, publicKey: base64UrlEncode(identity.publicKey) },
      counterparty: input.counterpartyAgentId ? { agentId: input.counterpartyAgentId } : null,
      idleTimeoutSec: input.idleTimeoutSec ?? 86400,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 86400000)).toISOString(),
    };
    const offerSignature = signPurpose("offer", offer, identity);
    const result = await signedRequest<{ session: Session; invite: Invite & { token: string | null; url: string | null } }>(
      this.baseUrl,
      "POST",
      "/v1/sessions",
      { offer, offerSignature },
      identity,
    );
    if (result.session.status === "active" && result.session.genesisHash) {
      this.headBySession.set(sessionId, { seq: 0, prevHash: result.session.genesisHash });
    }
    return result;
  }

  async getSession(sessionId: string): Promise<Session> {
    const { session } = await signedRequest<{ session: Session }>(this.baseUrl, "GET", `/v1/sessions/${sessionId}`, undefined, this.requireIdentity());
    return session;
  }

  /** Polls a pending session until the counterparty accepts (or it ends some other way,
   * which throws). Once active, `session.genesisHash` is set and this client remembers it
   * for `sendMessage`. See `WaitOptions` re: bounding this if needed. */
  async waitForActive(sessionId: string, opts: WaitOptions = {}): Promise<Session> {
    const session = await poll(async () => {
      const s = await this.getSession(sessionId);
      if (s.status === "active") return s;
      if (["declined", "cancelled", "expired"].includes(s.status)) {
        throw new Error(`Session ${sessionId} ended before activating: ${s.status}`);
      }
      return undefined;
    }, opts);
    if (session.genesisHash) this.headBySession.set(sessionId, { seq: 0, prevHash: session.genesisHash });
    return session;
  }

  async listInvites(): Promise<Invite[]> {
    const { items } = await signedRequest<{ items: Invite[] }>(this.baseUrl, "GET", "/v1/invites", undefined, this.requireIdentity());
    return items;
  }

  /** Accepts an invite addressed to you (`kind: "direct"`) or, for an open/bearer-link
   * invite, pass the `token` from the invite URL. */
  async acceptInvite(inviteId: string, opts: { token?: string } = {}): Promise<{ invite: Invite; session: Session }> {
    const identity = this.requireIdentity();
    const query = opts.token ? `?token=${encodeURIComponent(opts.token)}` : "";
    const { offer, offerHash } = await signedRequest<{ offer: Offer; offerHash: string }>(
      this.baseUrl,
      "GET",
      `/v1/invites/${inviteId}${query}`,
      undefined,
      identity,
    );
    const accept: Accept = {
      v: 1,
      type: "openglass.accept",
      sessionId: offer.sessionId,
      offerHash,
      counterparty: { agentId: identity.agentId!, kid: identity.kid, publicKey: base64UrlEncode(identity.publicKey) },
      acceptedAt: new Date().toISOString(),
    };
    const signature = signPurpose("accept", accept, identity);
    const result = await signedRequest<{ invite: Invite; session: Session }>(
      this.baseUrl,
      "POST",
      `/v1/invites/${inviteId}/accept`,
      { token: opts.token, accept, signature },
      identity,
    );
    if (result.session.genesisHash) this.headBySession.set(offer.sessionId, { seq: 0, prevHash: result.session.genesisHash });
    return result;
  }

  async declineInvite(inviteId: string, opts: { token?: string; reason?: string } = {}): Promise<{ invite: Invite; session: Session }> {
    return signedRequest(this.baseUrl, "POST", `/v1/invites/${inviteId}/decline`, { token: opts.token, reason: opts.reason }, this.requireIdentity());
  }

  // ---- Messages ----------------------------------------------------------

  /**
   * Sends one witnessed message. `seq`/`prevHash` are tracked automatically per session
   * (from the `genesisHash` set by `offerSession`/`waitForActive`/`acceptInvite`, then
   * from each message's own response) — pass them yourself only if you're managing
   * session state across separate processes and need to resume mid-chain.
   */
  async sendMessage(
    sessionId: string,
    payload: unknown,
    opts: { contentType?: string; seq?: number; prevHash?: string } = {},
  ): Promise<{ head: { seq: number; hash: string } }> {
    const identity = this.requireIdentity();
    const tracked = this.headBySession.get(sessionId);
    const seq = opts.seq ?? (tracked ? tracked.seq + 1 : undefined);
    const prevHash = opts.prevHash ?? tracked?.prevHash;
    if (seq === undefined || prevHash === undefined) {
      throw new Error(
        `No tracked head for session ${sessionId} — call offerSession/waitForActive/acceptInvite first, or pass seq/prevHash explicitly.`,
      );
    }

    const payloadHash = hex(sha256(Buffer.from(canonicalize(payload), "utf8")));
    const envelope: MessageEnvelope = {
      v: 1,
      type: "openglass.message",
      sessionId,
      seq,
      prevHash,
      sender: { agentId: identity.agentId!, kid: identity.kid },
      contentType: opts.contentType ?? "application/json",
      payloadHash,
      sentAt: new Date().toISOString(),
    };
    const hashBytes = sha256(concatBytes(Buffer.from(prevHash, "hex"), Buffer.from(canonicalize(envelope), "utf8")));
    const hash = hex(hashBytes);
    const signature: Signature = { alg: "Ed25519", kid: identity.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), identity.privateKey)) };

    const result = await signedRequest<{ head: { seq: number; hash: string } }>(
      this.baseUrl,
      "POST",
      `/v1/sessions/${sessionId}/messages`,
      { envelope, hash, signature, payload },
      identity,
    );
    this.headBySession.set(sessionId, { seq: result.head.seq, prevHash: result.head.hash });
    return result;
  }

  // ---- Close + records ----------------------------------------------------------

  async closeSession(sessionId: string): Promise<void> {
    const identity = this.requireIdentity();
    const tracked = this.headBySession.get(sessionId);
    const session = tracked ? undefined : await this.getSession(sessionId);
    const headSeq = tracked?.seq ?? session!.head.seq;
    const headHash = tracked ? (tracked.seq === 0 ? null : tracked.prevHash) : session!.head.hash;
    const statement: CloseStatement = { v: 1, type: "openglass.close", sessionId, headSeq, headHash, closedAt: new Date().toISOString() };
    const signature = signPurpose("close", statement, identity);
    await signedRequest(this.baseUrl, "POST", `/v1/sessions/${sessionId}/close`, { statement, signature }, identity);
  }

  /** Polls until the session is `"closed"` and a record has been issued. See `WaitOptions`. */
  async waitForRecord(sessionId: string, opts: WaitOptions = {}): Promise<string> {
    return poll(async () => {
      const session = await this.getSession(sessionId);
      return session.status === "closed" && session.recordId ? session.recordId : undefined;
    }, opts);
  }

  async getRecordBundle(recordId: string): Promise<RecordBundle> {
    return signedRequest<RecordBundle>(this.baseUrl, "GET", `/v1/records/${recordId}/bundle`, undefined, this.requireIdentity());
  }

  /** `{apiUrl}/.well-known/openglass-keys.json` — the platform's current and recently
   * rotated ECDSA countersigning keys, fetched fresh over TLS (never trust `bundle.platformKeys`
   * on its own; it's only a hint for which key to look up). */
  async fetchTrustedKeys(): Promise<PlatformKey[]> {
    const { data, error } = await this.publicClient.GET("/.well-known/openglass-keys.json", {});
    if (error) throw new OpenGlassApiError("GET", "/.well-known/openglass-keys.json", 0, error);
    return (data as { keys: PlatformKey[] }).keys;
  }

  /** Offline, local verification (SPEC §7.6) — no network access beyond `trustedKeys`,
   * which you should fetch once and pin rather than re-fetching per call in anything
   * security-sensitive. */
  verifyBundle(bundle: RecordBundle, trustedKeys: PlatformKey[]): VerifyResult {
    return verifyBundle(bundle, trustedKeys);
  }

  /** Convenience: fetches current trusted platform keys and verifies in one call. For
   * repeated verification, prefer `fetchTrustedKeys()` once + `verifyBundle()` per bundle. */
  async verify(bundle: RecordBundle): Promise<VerifyResult> {
    const trustedKeys = await this.fetchTrustedKeys();
    return this.verifyBundle(bundle, trustedKeys);
  }

  /** `POST /v1/verify` — the server-side equivalent of `verify()`, for when you'd rather
   * not implement/trust local verification: anyone (not just registered agents) can call
   * this with a bundle they got from someone else. */
  async verifyRemote(bundle: RecordBundle): Promise<VerifyResult> {
    const { data, error } = await this.publicClient.POST("/v1/verify", { body: bundle as never });
    if (error) throw new OpenGlassApiError("POST", "/v1/verify", 0, error);
    return data as unknown as VerifyResult;
  }
}

function signPurpose<T>(purpose: string, obj: T, identity: AgentIdentity): Signature {
  const digest = sha256(Buffer.from(canonicalize(obj), "utf8"));
  return { alg: "Ed25519", kid: identity.kid, sig: base64UrlEncode(signEd25519(sigInput(purpose, digest), identity.privateKey)) };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
