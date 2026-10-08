// Shared types/helpers for the owner dashboard (apps/web/app/dashboard, /login).
// Shapes here mirror apps/api's view functions exactly (domain/agentViews.ts,
// domain/sessionViews.ts, routes/owner.ts, routes/records.ts) — keep them in sync.

export interface Owner {
  id: string;
  email: string;
  displayName: string | null;
  settings: { requireInviteApproval: boolean; emailOnRecord: boolean; publicFeedOptIn?: boolean; oversightAlerts?: boolean };
  createdAt: string;
}

export interface DomainVerification {
  domain: string;
  token: string;
  status: "pending" | "verified";
  requestedAt: string;
  verifiedAt: string | null;
}

export interface OwnerAgent {
  id: string;
  name: string;
  description: string;
  meta: { homepage?: string; software?: string };
  status: "unclaimed" | "active" | "suspended";
  claimed: boolean;
  fingerprint: string;
  createdAt: string;
  claimedAt: string | null;
  suspendedAt: string | null;
  verifiedBadge: boolean;
  domainVerified: boolean;
  domainVerification: DomainVerification | null;
  spendLimitUsdCents: number | null;
  totalSpendUsdCents: number;
  publicDirectory: boolean;
  privateRetentionDays: number | null;
  defaultVisibility: "private" | "sealed" | "shared" | null;
}

export interface AgentPublic {
  id: string;
  name: string;
  description: string;
  status: "unclaimed" | "active" | "suspended";
  claimed: boolean;
  fingerprint: string;
  createdAt: string;
  domainVerified: boolean;
}

export interface SessionParticipant {
  agentId: string | null;
  ownerId: string | null;
  kid: string | null;
}

export interface SessionPause {
  requestedBy: string;
  reason: string;
  requestedAt: string;
}

export interface OwnerSession {
  id: string;
  mode: "relay" | "notary";
  status: "pending" | "active" | "paused" | "closing" | "closed" | "declined" | "cancelled" | "expired";
  purpose: string;
  initiator: SessionParticipant;
  counterparty: SessionParticipant;
  head: { seq: number; hash: string | null };
  messageCount: number;
  createdAt: string;
  activatedAt: string | null;
  closedAt: string | null;
  recordId: string | null;
  pause: SessionPause | null;
  visibility?: "private" | "sealed" | "shared" | null;
}

export interface OwnerAttestation {
  id: string;
  mode: "relay" | "notary";
  status: "active" | "closing" | "closed";
  purpose: string;
  attestor: { agentId: string; ownerId: string; kid: string };
  eventCount: number;
  createdAt: string;
  activatedAt: string;
  closedAt: string | null;
  recordId: string | null;
  visibility?: "private" | "sealed" | "shared" | null;
  /** Present on GET /v1/attestations/{id} (not in list responses). */
  genesisHash?: string;
  head?: { seq: number; hash: string | null };
}

export interface SealedState {
  status: "sealed" | "unseal_requested" | "unsealed" | "disputed";
  requestedBy: string | null;
  approvals: string[];
  unsealedAt?: string | null;
  disputedBy: string | null;
  disputedAt?: string | null;
}

export interface ViewerGrant {
  id: string;
  ownerId: string;
  agentId: string;
  viewerEmail: string;
  label: string | null;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  scope: "read" | "export" | "manage";
}

export interface AccessLogEntry {
  viewerEmail: string;
  action: "list_sessions" | "list_attestations" | "list_records" | "view_record_bundle";
  resourceId: string | null;
  at: string;
}

export interface ViewerAccessItem {
  grant: ViewerGrant;
  agent: AgentPublic | null;
}

export interface OwnerInvite {
  id: string;
  sessionId: string;
  fromAgentId: string;
  kind: "direct" | "open";
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface MessageView {
  id: string;
  sessionId: string;
  seq: number;
  envelope: {
    sender: { agentId: string; kid: string };
    contentType: string;
    payloadHash: string;
    sentAt: string;
  };
  hash: string;
  signature: { alg: string; kid: string; sig: string };
  receivedAt: string;
  platformSignature: { alg: string; kid: string; sig: string };
  /** Relay mode only; any JSON value the agent sent. Absent in Notary mode. */
  payload?: unknown;
}

/** A URL OpenGlass itself fetched and witnessed directly, on an attestor's request —
 * unlike MessageView, there's no agent signature: the platform is the sole, direct
 * witness of its own fetch. See docs/SPEC.md §12's "Naming a counterparty" vs this. */
export interface FetchWitnessView {
  id: string;
  attestationId: string;
  requestedBy: string;
  seq: number;
  prevHash: string;
  url: string;
  method: "GET" | "POST";
  /** Present only for `method: "POST"` — the JSON body OpenGlass itself sent. */
  request: { contentType: "application/json"; bodySha256: string; bodyBytes: number; bodyText: string } | null;
  requestedAt: string;
  fetchedAt: string;
  response: {
    status: number;
    headers: Record<string, string>;
    contentType: string | null;
    bodySha256: string;
    bodyBytes: number;
    bodyTruncated: boolean;
    bodyText: string | null;
  };
  hash: string;
  platformSignature: { alg: string; kid: string; sig: string };
}

export interface RecordSummary {
  id: string;
  sessionId: string;
  statement: {
    participants: { role: "initiator" | "counterparty"; agentId: string; ownerId: string; kid: string }[];
    genesisHash: string;
    headSeq: number;
    headHash: string;
    messageCount: number;
    activatedAt: string;
    closedAt: string;
    closeReason: string;
    closedBy: string | null;
    evidenceSha256: string;
    issuedAt: string;
  };
  statementHash: string;
  evidence: { sha256: string; bytes: number };
  createdAt: string;
  visibility?: "private" | "sealed" | "shared" | null;
  /** SPEC §13.2: the one dispute flag per record, on any visibility. */
  dispute?: { disputedBy: string; disputedAt: string } | null;
  sealedState?: SealedState | null;
}

/** `POST /v1/verify` response (SPEC §7.6, packages/db/src/crypto/verifyBundle.ts). */
export interface VerifyIssue {
  code: string;
  seq?: number;
  message: string;
}

export interface VerifyResult {
  valid: boolean;
  errors: VerifyIssue[];
  /** Non-failing notes, e.g. content_encrypted for a private record. */
  info?: VerifyIssue[];
}

export interface LiveFeedItem {
  sessionId: string;
  seq: number;
  senderAgentId: string;
  senderName: string;
  text: string | null;
  hash: string;
  receivedAt: string;
}

export interface LiveFeedResponse {
  /** Registered agents, plus every domain OpenGlass has independently fetch-witnessed
   * (docs/SPEC.md §12.6) that isn't already one of those agents' own domain. */
  stats: { activeAgents: number; sessionsStarted: number; totalRecords: number; sessionRecords: number; attestationRecords: number; publicSessions: number };
  items: LiveFeedItem[];
  nextCursor: string | null;
}

// Realignment R2/R3 (docs/SPEC.md §14) — mirrors apps/api/src/domain/lookup.ts's
// RegisteredLookupResult/UnregisteredLookupResult exactly.
export interface LookupActivity {
  sessionsLast90d: number;
  attestationsLast90d: number;
  distinctCounterparties: number;
  normalCloseShare: number | null;
}

export interface LookupFlags {
  newAgent: boolean;
  unverifiedDomain: boolean;
  recentlyRotatedKey: boolean;
}

export interface RegisteredLookupResult {
  registered: true;
  agentId: string;
  name: string;
  claimed: boolean;
  verifiedOwner: { domain: string } | null;
  firstSeen: string;
  keyAgeDays: number;
  software: string | null;
  activity: LookupActivity;
  openDisputesCount: number;
  flags: LookupFlags;
}

export interface UnregisteredLookupResult {
  registered: false;
  agentCard: { name?: string; description?: string } | null;
  mcpRegistryEntry: unknown | null;
  domainRegisteredAt: string | null;
  inviteUrl: string;
  /** docs/SPEC.md §16. Absent from servers that predate unclaimed profiles. */
  unclaimedProfile?: UnclaimedProfile | null;
}

export interface UnclaimedProfile {
  domain: string;
  agentCardUrl: string | null;
  cardSha256: string | null;
  cardFetchedAt: string | null;
  listedBy: string;
  listedAt: string;
  lastSeenAt: string;
  claimed: boolean;
  claimedAgentId: string | null;
  claimedAt: string | null;
  profileUrl: string;
  claimUrl: string;
}

export type LookupResult = RegisteredLookupResult | UnregisteredLookupResult;

/** `GET /v1/owner/counterparty-profiles` (docs/SPEC.md §16): a counterparty one of the
 * owner's agents listed because it isn't registered on OpenGlass. */
export interface CounterpartyListing {
  listedByAgentId: string;
  firstListedAt: string;
  lastListedAt: string;
  profile: UnclaimedProfile;
}

export type IntegrationStatus = "requested" | "in_progress" | "available" | "native";

export interface IntegrationEvidence {
  label: string;
  url: string;
}

export interface IntegrationCard {
  slug: string;
  name: string;
  url: string;
  description: string;
  category: string;
  evidence: IntegrationEvidence[];
  status: IntegrationStatus;
  voteCount: number;
  hasVoted: boolean;
}

export interface IntegrationRequest {
  id: string;
  frameworkName: string;
  frameworkUrl: string | null;
  note: string | null;
  requesterEmail: string;
  status: "new" | "reviewed";
  createdAt: string;
}

export const INTEGRATION_STATUS_LABEL: Record<IntegrationStatus, string> = {
  requested: "Requested",
  in_progress: "In progress",
  available: "Available",
  native: "Native",
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** All owner-facing endpoints are same-origin and cookie-authenticated (SPEC §4.2) —
 * no bearer token to attach, just forward the browser's own cookie jar. Every
 * state-changing request needs `Content-Type: application/json` (verifyOwnerSession
 * checks it even for a body-less POST like suspend/resume) — defaulted here so callers
 * don't have to remember it themselves. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  const headers = method === "GET" ? init?.headers : { "content-type": "application/json", ...init?.headers };
  const res = await fetch(path, { credentials: "same-origin", ...init, headers });
  if (res.status === 401) throw new ApiError(401, "unauthenticated");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, body?.error?.message ?? `${path} -> ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const STATUS_LABEL: Record<string, string> = {
  unclaimed: "Unclaimed",
  active: "Active",
  suspended: "Suspended",
  pending: "Pending",
  paused: "Paused",
  closing: "Closing",
  closed: "Closed",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
  revoked: "Revoked",
};

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function shortHash(hash: string | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 8)}…${hash.slice(-5)}`;
}

export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Outcome of checking a record from the dashboard: a verification result, or why only
 * a receipt could be checked (a legacy sealed record that hasn't been opened yet). */
export type RecordCheck = { kind: "verified"; result: VerifyResult } | { kind: "receipt-only" };

/**
 * Fetches a record's bundle and runs it through the public `POST /v1/verify` (SPEC §7.6),
 * the same check anyone can run. A sealed record that hasn't been opened returns a receipt
 * (no evidence), which can't be verified end to end, so that's reported instead of sent.
 * A failed verify request (4xx/5xx) throws rather than being mistaken for a result.
 */
export async function checkRecord(recordId: string): Promise<RecordCheck> {
  const bundle = await apiFetch<{ type?: string }>(`/v1/records/${recordId}/bundle`);
  if (bundle.type === "openglass.receipt") return { kind: "receipt-only" };
  const res = await fetch("/v1/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
  const json = (await res.json().catch(() => null)) as (VerifyResult & { error?: { message?: string } }) | null;
  if (!res.ok || !json || !Array.isArray(json.errors)) {
    throw new Error(json?.error?.message ?? `Verification request failed (${res.status})`);
  }
  return { kind: "verified", result: json };
}
