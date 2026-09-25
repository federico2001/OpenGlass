import { ObjectId } from "mongodb";

const U = "01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const U2 = "01J8Z3K4M5N6P7Q8R9S0T1V2W4";
const now = new Date("2026-09-22T22:07:00.000Z");
const iso = "2026-09-22T22:07:00.000Z";
const hash = "a".repeat(64);
const pk = "A".repeat(43);
const sig = (kid: string) => ({ alg: "Ed25519", kid, sig: "c2lnbmF0dXJl" });

const offer = {
  v: 1, type: "openglass.offer", sessionId: `ses_${U}`, mode: "relay", purpose: "Negotiate delivery",
  initiator: { agentId: `agt_${U}`, kid: `key_${U}`, publicKey: pk },
  counterparty: { agentId: `agt_${U2}` }, idleTimeoutSec: 86400, createdAt: iso, expiresAt: iso,
};
const accept = {
  v: 1, type: "openglass.accept", sessionId: `ses_${U}`, offerHash: hash,
  counterparty: { agentId: `agt_${U2}`, kid: `key_${U2}`, publicKey: pk }, acceptedAt: iso,
};

/** One valid document per collection. */
export const validDocs: Record<string, Record<string, unknown>> = {
  owners: {
    _id: `own_${U}`, email: "alice@example.com", displayName: null,
    settings: { requireInviteApproval: false, emailOnRecord: true },
    status: "active", createdAt: now, updatedAt: now, lastLoginAt: null,
  },
  agents: {
    _id: `agt_${U}`, name: "Acme Bot", description: "", meta: {},
    keys: [{ kid: `key_${U}`, alg: "Ed25519", publicKey: pk, createdAt: now, revokedAt: null }],
    ownerId: null, status: "unclaimed", claim: { tokenHash: hash, expiresAt: now },
    claimedAt: null, suspendedAt: null, createdAt: now, updatedAt: now,
  },
  sessions: {
    _id: `ses_${U}`, mode: "relay", status: "active", purpose: "Negotiate delivery",
    initiator: { agentId: `agt_${U}`, ownerId: `own_${U}`, kid: `key_${U}` },
    counterparty: { agentId: `agt_${U2}`, ownerId: `own_${U2}`, kid: `key_${U2}` },
    inviteId: `inv_${U}`, offer, offerSignature: sig(`key_${U}`), accept, acceptSignature: sig(`key_${U2}`),
    genesisHash: hash, genesisSignature: sig("plat_2026a"), head: { seq: 0, hash: null }, messageCount: 0,
    idleTimeoutSec: 86400, createdAt: now, activatedAt: now, lastActivityAt: now, expiresAt: now,
    pause: null, closing: null, closedAt: null, recordId: null,
  },
  invites: {
    _id: `inv_${U}`, sessionId: `ses_${U}`, fromAgentId: `agt_${U}`, kind: "open", toAgentId: null,
    tokenHash: hash, status: "pending", ownerApproval: null, expiresAt: now, createdAt: now, respondedAt: null,
  },
  messages: {
    _id: `msg_${U}`, sessionId: `ses_${U}`, seq: 1,
    envelope: {
      v: 1, type: "openglass.message", sessionId: `ses_${U}`, seq: 1, prevHash: hash,
      sender: { agentId: `agt_${U}`, kid: `key_${U}` }, contentType: "application/json", payloadHash: hash, sentAt: iso,
    },
    hash, signature: sig(`key_${U}`), receivedAt: now, platformSignature: sig("plat_2026a"),
    payload: { proposal: { deliveryDate: "2026-10-01" } },
  },
  records: {
    _id: `rec_${U}`, sessionId: `ses_${U}`,
    statement: {
      v: 1, type: "openglass.record", recordId: `rec_${U}`, sessionId: `ses_${U}`, mode: "relay", purpose: "x",
      participants: [
        { role: "initiator", agentId: `agt_${U}`, ownerId: `own_${U}`, kid: `key_${U}`, publicKey: pk },
        { role: "counterparty", agentId: `agt_${U2}`, ownerId: `own_${U2}`, kid: `key_${U2}`, publicKey: pk },
      ],
      genesisHash: hash, headSeq: 1, headHash: hash, messageCount: 1, activatedAt: iso, closedAt: iso,
      closeReason: "agent_closed", closedBy: `agt_${U}`, evidenceSha256: hash, issuedAt: iso,
    },
    statementHash: hash, platformSignature: sig("plat_2026a"),
    evidence: { s3Key: `records/rec_${U}/evidence.json`, sha256: hash, bytes: 1234 },
    participantAgentIds: [`agt_${U}`, `agt_${U2}`], participantOwnerIds: [`own_${U}`, `own_${U2}`], createdAt: now,
  },
  viewer_grants: {
    _id: `vwg_${U}`, ownerId: `own_${U}`, agentId: `agt_${U}`, viewerEmail: "legal@example.com",
    label: "Legal counsel", status: "active", createdAt: now, revokedAt: null,
  },
  login_tokens: { _id: hash, email: "alice@example.com", redirectTo: "/", expiresAt: now, createdAt: now },
  web_sessions: { _id: hash, ownerId: `own_${U}`, createdAt: now, expiresAt: now },
  request_nonces: { _id: `agt_${U}:abc`, expiresAt: now },
  rate_limits: { _id: `message_send:agt_${U}:1790000000`, count: 3, expiresAt: now },
  activity_snapshots: {
    _id: "2026-09-22", takenAt: now,
    agents: { total: 10, unclaimed: 2, active: 7, suspended: 1, verifiedBadge: 1 },
    owners: { total: 8 },
    sessions: { total: 5, pending: 1, active: 1, closing: 0, closed: 3, declined: 0, cancelled: 0, expired: 0 },
    messages: { total: 20 },
    records: { total: 3 },
    packages: { npmWeeklyDownloads: 12, pypiDailyDownloads: 2, pypiWeeklyDownloads: 9, pypiMonthlyDownloads: 30 },
    github: { stars: 4, forks: 1, watchers: 2, openIssues: 0 },
  },
  changelog: { _id: new ObjectId(), fileName: "20260922000000-x.js", appliedAt: now, migrationBlock: Date.now() },
  migration_lock: { _id: "migrate", holder: "h", expiresAt: now },
};

/** Documents that both Zod and the $jsonSchema validator must reject. */
export const invalidDocs: [collection: string, why: string, doc: Record<string, unknown>][] = [
  ["owners", "unknown field", { ...validDocs.owners, isAdmin: true }],
  ["owners", "uppercase email", { ...validDocs.owners, email: "Alice@Example.com" }],
  ["agents", "no keys", { ...validDocs.agents, keys: [] }],
  ["agents", "bad status", { ...validDocs.agents, status: "deleted" }],
  [
    "agents",
    "bad domainVerification status",
    { ...validDocs.agents, domainVerification: { domain: "example.com", token: "t", status: "verified-ish", requestedAt: now, verifiedAt: null } },
  ],
  ["sessions", "bad mode", { ...validDocs.sessions, mode: "broadcast" }],
  ["sessions", "negative head", { ...validDocs.sessions, head: { seq: -1, hash: null } }],
  ["invites", "bad kind", { ...validDocs.invites, kind: "email" }],
  ["messages", "seq 0", { ...validDocs.messages, seq: 0 }],
  ["messages", "hash not hex", { ...validDocs.messages, hash: "zz" }],
  ["messages", "timestamp as string", { ...validDocs.messages, receivedAt: "2026-09-22" }],
  ["records", "one participant", { ...validDocs.records, participantAgentIds: [`agt_${U}`] }],
  ["viewer_grants", "uppercase email", { ...validDocs.viewer_grants, viewerEmail: "Legal@Example.com" }],
  ["viewer_grants", "bad status", { ...validDocs.viewer_grants, status: "pending" }],
  ["rate_limits", "fractional count", { ...validDocs.rate_limits, count: 1.5 }],
];
