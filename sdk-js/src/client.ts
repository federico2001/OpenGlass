import { generateEd25519KeyPair, base64UrlEncode, signEd25519 } from "./crypto/ed25519.js";
import { canonicalize } from "./crypto/canonicalJson.js";
import { hex, sha256 } from "./crypto/hash.js";
import { sigInput } from "./crypto/sigInput.js";
import { verifyBundle, type VerifyResult } from "./crypto/verifyBundle.js";
import { OpenGlassApiError, randomAttestationId, randomSessionId, signedRequest, sleep } from "./http.js";
import { createPublicClient, type PublicClient } from "./publicClient.js";
import type {
  Accept,
  AgentIdentity,
  AttestationOpen,
  CloseReason,
  CloseStatement,
  MessageEnvelope,
  Mode,
  Offer,
  PlatformKey,
  RecordBundle,
  SealedState,
  Signature,
  Visibility,
} from "./types.js";
import type { components } from "./generated/openapi.js";

/** Realignment R2 (docs/SPEC.md §14.2). Re-exported from the generated OpenAPI schema
 * rather than hand-duplicated, so it can never drift from what the server actually sends. */
export type LookupResult = components["schemas"]["LookupResult"];
export type DomainVerification = components["schemas"]["DomainVerification"];
export type UnclaimedProfile = components["schemas"]["UnclaimedProfile"];

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
  domainVerified: boolean;
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
  domainVerified: boolean;
  ownerId: string | null;
  claimedAt: string | null;
  suspendedAt: string | null;
}

export interface Session {
  id: string;
  mode: Mode;
  status: "pending" | "active" | "paused" | "closing" | "closed" | "declined" | "cancelled" | "expired";
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
  /** Realignment R1 (docs/SPEC.md §13). Absent on a session issued before this field
   * existed. Defaults to "shared" when the caller didn't request one at creation. */
  visibility?: Visibility;
  /** Prompt 6: set while an agent has paused this session pending its owner's review. */
  pause: { requestedBy: string; reason: string; requestedAt: string } | null;
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

/** SPEC §12: the one-party counterpart to `Session` — a single agent logging its own
 * action, with no counterparty to invite or accept. */
export interface Attestation {
  id: string;
  mode: Mode;
  status: "active" | "closing" | "closed";
  purpose: string;
  attestor: { agentId: string; ownerId: string | null; kid: string };
  genesisHash: string;
  genesisSignature: Signature;
  head: { seq: number; hash: string | null };
  eventCount: number;
  idleTimeoutSec: number;
  createdAt: string;
  activatedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  /** Realignment R1 (docs/SPEC.md §13). Defaults to "private" when omitted at open time. */
  visibility?: Visibility;
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
  /** Default `https://openglass.glass` in a real deployment — pass your own for local/dev. */
  baseUrl?: string;
  identity?: AgentIdentity;
  /** Injectable for tests (e.g. mocking `lookup()`/`guard()`'s network calls); defaults to
   * the global `fetch`. Currently only wired into this client's unauthenticated calls
   * (`lookup`, `getAgent`, `fetchTrustedKeys`, `verifyRemote`) — every signed request still
   * uses the global `fetch` directly, matching `core-js`'s own `AttestOptions.fetchImpl`,
   * which only ever needs to intercept `guard()`'s public lookup. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://openglass.glass";

/**
 * The OpenGlass client: register an agent, get claimed, run a witnessed session, and
 * independently verify the resulting record — all signed locally with your own Ed25519
 * key, which never leaves this process.
 */
export class OpenGlassClient {
  readonly baseUrl: string;
  identity?: AgentIdentity;
  private headBySession = new Map<string, { seq: number; prevHash: string }>();
  private headByAttestation = new Map<string, { seq: number; prevHash: string }>();
  private publicClient: PublicClient;

  constructor(opts: OpenGlassClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.identity = opts.identity;
    this.publicClient = createPublicClient(this.baseUrl, opts.fetchImpl);
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

  // ---- Lookup & domain verification (realignment R2/R7) --------------------------------

  /** `GET /v1/lookup` — check any agent, registered or not, before offering or accepting a
   * session with it. Public: no auth, no signing, works before you've even registered
   * yourself. Pass exactly one of `agentId`, `domain`, `agentCardUrl`, `publicKey`. */
  async lookup(query: { agentId: string } | { domain: string } | { agentCardUrl: string } | { publicKey: string }): Promise<LookupResult> {
    const { data, error } = await this.publicClient.GET("/v1/lookup", { params: { query } });
    if (error) throw new OpenGlassApiError("GET", "/v1/lookup", 0, error);
    return data as LookupResult;
  }

  /** `POST /v1/profiles/unclaimed` (docs/SPEC.md §16): lists a counterparty that isn't
   * registered on OpenGlass as an unclaimed profile, so its operator can find and claim it
   * and your owner sees it among your counterparties. Name it in exactly one way: its
   * `domain`, its `agentCardUrl`, or the `agentCard` itself as you received it. OpenGlass
   * fetches the card itself and stores only its URL and hash. Idempotent per domain.
   * Throws `already_registered` (409, `details.agentId`) when an agent on OpenGlass already
   * claims that domain: look that agent up by id instead. Requires a claimed `this.identity`. */
  async registerCounterparty(
    counterparty: { domain: string } | { agentCardUrl: string } | { agentCard: Record<string, unknown> },
  ): Promise<UnclaimedProfile> {
    const identity = this.requireIdentity();
    const { profile } = await signedRequest<{ profile: UnclaimedProfile }>(this.baseUrl, "POST", "/v1/profiles/unclaimed", counterparty, identity);
    return profile;
  }

  /** Starts domain verification for your own `meta.homepage`: generates a token and
   * returns instructions for all three proof methods (a DNS TXT record, or one of two
   * well-known files). Requires `this.identity`. */
  async requestDomainVerification(): Promise<DomainVerification> {
    const identity = this.requireIdentity();
    const { domainVerification } = await signedRequest<{ domainVerification: DomainVerification }>(
      this.baseUrl,
      "POST",
      "/v1/agents/me/domain-verification",
      undefined,
      identity,
    );
    return domainVerification;
  }

  /** Checks whether any of the three proof methods `requestDomainVerification()` described
   * now succeed — call this after you've actually published the token. Throws
   * `domain_verification_not_requested` (via `OpenGlassApiError`) if you haven't called
   * `requestDomainVerification()` first. */
  async verifyDomain(): Promise<DomainVerification> {
    const identity = this.requireIdentity();
    const { domainVerification } = await signedRequest<{ domainVerification: DomainVerification }>(
      this.baseUrl,
      "POST",
      "/v1/agents/me/domain-verification/check",
      undefined,
      identity,
    );
    return domainVerification;
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
    /** docs/SPEC.md §13. Defaults to "shared" when omitted: both participant owners can
     * read the full record from the moment it's issued. "sealed" is deprecated. A
     * "private" request falls back to "shared" (same readers, content kept) server-side if content encryption
     * isn't configured there. */
    visibility?: Visibility;
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
      { offer, offerSignature, ...(input.visibility ? { visibility: input.visibility } : {}) },
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
  /**
   * Sends one witnessed message. `seq`/`prevHash` (the message's place in the hash chain)
   * are handled for you: this client tracks the head from its own sends, reads it from the
   * session when it doesn't know it yet (e.g. the initiator right after the counterparty
   * accepts, or a fresh process), and when the other agent has sent something in between
   * (the server answers `409 chain_conflict` with the real head, docs/SPEC.md §5.3/D8)
   * re-chains onto that head and retries, up to `retryOnConflict` times (default 3). Pass
   * `seq`/`prevHash` yourself only to manage chain state explicitly; no automatic retry
   * happens then.
   */
  async sendMessage(
    sessionId: string,
    payload: unknown,
    opts: { contentType?: string; seq?: number; prevHash?: string; retryOnConflict?: number } = {},
  ): Promise<{ head: { seq: number; hash: string } }> {
    const identity = this.requireIdentity();
    const manual = opts.seq !== undefined || opts.prevHash !== undefined;
    const maxRetries = opts.retryOnConflict ?? 3;
    for (let attempt = 0; ; attempt++) {
      let seq: number | undefined;
      let prevHash: string | undefined;
      if (manual) {
        const tracked = this.headBySession.get(sessionId);
        seq = opts.seq ?? (tracked ? tracked.seq + 1 : undefined);
        prevHash = opts.prevHash ?? tracked?.prevHash;
        if (seq === undefined || prevHash === undefined) {
          throw new Error(`No tracked head for session ${sessionId} — pass both seq and prevHash, or neither.`);
        }
      } else {
        const head = this.headBySession.get(sessionId) ?? (await this.fetchSessionHead(sessionId));
        seq = head.seq + 1;
        prevHash = head.prevHash;
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

      try {
        const result = await signedRequest<{ head: { seq: number; hash: string } }>(
          this.baseUrl,
          "POST",
          `/v1/sessions/${sessionId}/messages`,
          { envelope, hash, signature, payload },
          identity,
        );
        this.headBySession.set(sessionId, { seq: result.head.seq, prevHash: result.head.hash });
        return result;
      } catch (err) {
        const conflict = chainConflictHead(err);
        if (manual || attempt >= maxRetries || conflict === undefined) throw err;
        if (conflict?.hash) this.headBySession.set(sessionId, { seq: conflict.seq, prevHash: conflict.hash });
        else this.headBySession.delete(sessionId); // re-read (and genesisHash) from the session
      }
    }
  }

  /** The session's current chain head, from the server: the last message's hash, or
   * `genesisHash` before any message. */
  private async fetchSessionHead(sessionId: string): Promise<{ seq: number; prevHash: string }> {
    const session = await this.getSession(sessionId);
    const prevHash = session.head?.hash ?? session.genesisHash;
    if (!prevHash) {
      throw new Error(
        `Session ${sessionId} isn't active yet (status: ${session.status}) — wait for the counterparty to accept (waitForActive) before sending.`,
      );
    }
    const head = { seq: session.head?.seq ?? 0, prevHash };
    this.headBySession.set(sessionId, head);
    return head;
  }


  // ---- Pause + close + records ----------------------------------------------------

  /** Prompt 6: pauses your own active session rather than sending the next message or
   * closing outright — e.g. before agreeing to something your owner should weigh in on.
   * Blocks further `sendMessage` calls (`409 session_not_active`) until the session's
   * owner (either participant's) resumes or declines it from the dashboard; there's no
   * agent-side resume, by design, since an agent un-pausing its own pause would offer no
   * oversight at all. */
  async pauseSession(sessionId: string, reason: string): Promise<Session> {
    const identity = this.requireIdentity();
    const { session } = await signedRequest<{ session: Session }>(this.baseUrl, "POST", `/v1/sessions/${sessionId}/pause`, { reason }, identity);
    return session;
  }

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

  // ---- Attestations (SPEC §12) — the one-party counterpart to a session ----------------

  /** Logs one of your own agent's actions — a payment, a tool call, a policy match — with
   * no counterparty to invite or accept. Activates immediately: no invite, no waiting on
   * anyone. Private by default (unlike a session, which defaults to shared). */
  async openAttestation(input: {
    purpose: string;
    mode?: Mode;
    attestationId?: string;
    idleTimeoutSec?: number;
    /** Realignment R1 (docs/SPEC.md §13). Defaults to "private" when omitted. Note there is
     * no separate per-call "retention" option here — retention on `visibility: "private"`
     * records is an owner-dashboard setting (`PATCH /v1/owner/agents/{id}/retention`), not
     * something an agent's own signed request can set; this client is agent-authenticated
     * only and has no owner-session support, so it doesn't expose a parameter that
     * wouldn't do anything. */
    visibility?: Visibility;
  }): Promise<{ attestation: Attestation }> {
    const identity = this.requireIdentity();
    const attestationId = input.attestationId ?? randomAttestationId();
    const open: AttestationOpen = {
      v: 1,
      type: "openglass.attestation_open",
      attestationId,
      mode: input.mode ?? "relay",
      purpose: input.purpose,
      attestor: { agentId: identity.agentId!, kid: identity.kid, publicKey: base64UrlEncode(identity.publicKey) },
      createdAt: new Date().toISOString(),
    };
    const openSignature = signPurpose("attestation_open", open, identity);
    const result = await signedRequest<{ attestation: Attestation }>(
      this.baseUrl,
      "POST",
      "/v1/attestations",
      { open, openSignature, idleTimeoutSec: input.idleTimeoutSec, ...(input.visibility ? { visibility: input.visibility } : {}) },
      identity,
    );
    if (result.attestation.genesisHash) this.headByAttestation.set(attestationId, { seq: 0, prevHash: result.attestation.genesisHash });
    return result;
  }

  async getAttestation(attestationId: string): Promise<Attestation> {
    const { attestation } = await signedRequest<{ attestation: Attestation }>(
      this.baseUrl,
      "GET",
      `/v1/attestations/${attestationId}`,
      undefined,
      this.requireIdentity(),
    );
    return attestation;
  }

  /** Appends one signed, hash-chained event — the one-party counterpart to `sendMessage`.
   * `seq`/`prevHash` are tracked automatically from `openAttestation`, same as sessions. */
  async sendAttestationEvent(
    attestationId: string,
    payload: unknown,
    opts: { contentType?: string; seq?: number; prevHash?: string } = {},
  ): Promise<{ head: { seq: number; hash: string } }> {
    const identity = this.requireIdentity();
    const tracked = this.headByAttestation.get(attestationId);
    const seq = opts.seq ?? (tracked ? tracked.seq + 1 : undefined);
    const prevHash = opts.prevHash ?? tracked?.prevHash;
    if (seq === undefined || prevHash === undefined) {
      throw new Error(`No tracked head for attestation ${attestationId} — call openAttestation first, or pass seq/prevHash explicitly.`);
    }

    const payloadHash = hex(sha256(Buffer.from(canonicalize(payload), "utf8")));
    const envelope: MessageEnvelope = {
      v: 1,
      type: "openglass.message",
      sessionId: attestationId,
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
      `/v1/attestations/${attestationId}/events`,
      { envelope, hash, signature, payload },
      identity,
    );
    this.headByAttestation.set(attestationId, { seq: result.head.seq, prevHash: result.head.hash });
    return result;
  }

  async closeAttestation(attestationId: string): Promise<void> {
    const identity = this.requireIdentity();
    const tracked = this.headByAttestation.get(attestationId);
    const attestation = tracked ? undefined : await this.getAttestation(attestationId);
    const headSeq = tracked?.seq ?? attestation!.head.seq;
    const headHash = tracked ? (tracked.seq === 0 ? null : tracked.prevHash) : attestation!.head.hash;
    const statement: CloseStatement = { v: 1, type: "openglass.close", sessionId: attestationId, headSeq, headHash, closedAt: new Date().toISOString() };
    const signature = signPurpose("close", statement, identity);
    await signedRequest(this.baseUrl, "POST", `/v1/attestations/${attestationId}/close`, { statement, signature }, identity);
  }

  /** Polls until the attestation is `"closed"` and a record has been issued. See `WaitOptions`. */
  async waitForAttestationRecord(attestationId: string, opts: WaitOptions = {}): Promise<string> {
    return poll(async () => {
      const attestation = await this.getAttestation(attestationId);
      return attestation.status === "closed" && attestation.recordId ? attestation.recordId : undefined;
    }, opts);
  }

  // ---- Disputes, and the legacy sealed-record ceremony (docs/SPEC.md §13.2) --------------

  /** For a `visibility: "sealed"` record: requests the unseal ceremony, implicitly counting
   * your own approval. Owner-authenticated in the REST API (a human decision on behalf of
   * a participant) — but the same agent-signed auth this client already uses works too,
   * since `verifyAgentOrOwner` accepts either. */
  async requestUnseal(recordId: string): Promise<{ record: { id: string; sealedState: SealedState } }> {
    return signedRequest(this.baseUrl, "POST", `/v1/records/${recordId}/unseal-request`, undefined, this.requireIdentity());
  }

  /** Adds your own approval; the record fully unseals once every participant owner has
   * called this. */
  async approveUnseal(recordId: string): Promise<{ record: { id: string; sealedState: SealedState } }> {
    return signedRequest(this.baseUrl, "POST", `/v1/records/${recordId}/unseal-approve`, undefined, this.requireIdentity());
  }

  /** Flags a two-party record as disputed (docs/SPEC.md §13.2). It changes and opens
   * nothing, except that it still force-unseals a legacy sealed record. Note: the route is
   * owner-authenticated (session cookie), so an agent-signed call gets 401. */
  async dispute(recordId: string): Promise<{ record: { id: string; sealedState: SealedState } }> {
    return signedRequest(this.baseUrl, "POST", `/v1/records/${recordId}/dispute`, undefined, this.requireIdentity());
  }

  // ---- guard() (realignment R7) ---------------------------------------------------------

  /**
   * A pre-flight check for a tool call your own policy layer (e.g. `openglass-policy` via
   * `core-js`/`core-py`) has already marked as worth a second look. `guard()` doesn't run
   * policy itself — pass in the risk level you've already computed. When that risk meets
   * `minRiskToCheck` (default `"high"`) and a `counterpartyAgentId` is given, it looks the
   * counterparty up (`lookup()`) and decides `allow` / `warn` / `block` from your own
   * `onUnverifiedDomain`/`onNewCounterparty` policy — there's no server-side "owner
   * config" this reads; you configure it locally, since only you (the integration) knows
   * what's appropriate for your own agent's risk tolerance. **Fails open**: if OpenGlass
   * itself is unreachable, returns `allow` rather than block a real task on an
   * infrastructure hiccup — this is advisory, not a hard gate.
   */
  async guard(opts: {
    risk: "low" | "medium" | "high" | (string & {});
    counterpartyAgentId?: string;
    minRiskToCheck?: "low" | "medium" | "high";
    onUnverifiedDomain?: "allow" | "warn" | "block";
    onNewCounterparty?: "allow" | "warn" | "block";
  }): Promise<{ action: "allow" | "warn" | "block"; reason: string; lookup?: LookupResult }> {
    const RANK = { low: 0, medium: 1, high: 2 };
    const threshold = RANK[opts.minRiskToCheck ?? "high"];
    const actual = RANK[opts.risk as "low" | "medium" | "high"] ?? RANK.high; // unknown risk labels are treated as high, not skipped
    if (actual < threshold) return { action: "allow", reason: `risk "${opts.risk}" is below the check threshold` };
    if (!opts.counterpartyAgentId) return { action: "allow", reason: "no counterparty to check" };

    let info: LookupResult;
    try {
      info = await this.lookup({ agentId: opts.counterpartyAgentId });
    } catch (err) {
      return { action: "allow", reason: `OpenGlass unreachable, failing open: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!info.registered) {
      const policy = opts.onNewCounterparty ?? "allow";
      return { action: policy, reason: "counterparty is not registered with OpenGlass at all", lookup: info };
    }
    if (info.flags.unverifiedDomain) {
      const policy = opts.onUnverifiedDomain ?? "warn";
      return { action: policy, reason: "counterparty's domain is not verified", lookup: info };
    }
    if (info.flags.newAgent) {
      const policy = opts.onNewCounterparty ?? "allow";
      return { action: policy, reason: "first time seeing this counterparty", lookup: info };
    }
    return { action: "allow", reason: "counterparty is registered, claimed, and domain-verified", lookup: info };
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

/** For a `409 chain_conflict` error: the server's current head (`null` hash before any
 * message). `undefined` for any other error. */
function chainConflictHead(err: unknown): { seq: number; hash: string | null } | null | undefined {
  if (!(err instanceof OpenGlassApiError) || err.status !== 409) return undefined;
  const error = (err.body as { error?: { code?: string; details?: { head?: { seq: number; hash: string | null } } } } | null)?.error;
  if (error?.code !== "chain_conflict") return undefined;
  return error.details?.head ?? null;
}
