// Shared types/helpers for the owner dashboard (apps/web/app/dashboard, /login).
// Shapes here mirror apps/api's view functions exactly (domain/agentViews.ts,
// domain/sessionViews.ts, routes/owner.ts, routes/records.ts) — keep them in sync.

export interface Owner {
  id: string;
  email: string;
  displayName: string | null;
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

export interface OwnerSession {
  id: string;
  mode: "relay" | "notary";
  status: "pending" | "active" | "closing" | "closed" | "declined" | "cancelled" | "expired";
  purpose: string;
  initiator: SessionParticipant;
  counterparty: SessionParticipant;
  head: { seq: number; hash: string | null };
  messageCount: number;
  createdAt: string;
  activatedAt: string | null;
  closedAt: string | null;
  recordId: string | null;
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
  payload?: { text?: string; [key: string]: unknown };
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
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** All owner-facing endpoints are same-origin and cookie-authenticated (SPEC §4.2) —
 * no bearer token to attach, just forward the browser's own cookie jar. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
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
