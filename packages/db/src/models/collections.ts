import { z } from "zod";
import {
  AgentId, Hash, InviteId, KeyId, MessageId, ObjectIdSchema, OwnerId, PublicKey,
  RecordId, SessionId, Signature, Kid, ViewerGrantId,
} from "./common.js";
import { Accept, CloseReason, CloseStatement, MessageEnvelope, Mode, Offer, RecordStatement } from "./protocol.js";
import { defineCollection } from "./define.js";

// Document shapes follow docs/SPEC.md §3.

export const owners = defineCollection({
  name: "owners",
  schema: z.strictObject({
    _id: OwnerId,
    email: z.string().max(254).regex(/^[^A-Z\s@]+@[^A-Z\s@]+$/),
    displayName: z.string().max(100).nullable(),
    settings: z.strictObject({
      requireInviteApproval: z.boolean(),
      emailOnRecord: z.boolean(),
    }),
    status: z.enum(["active", "disabled"]),
    createdAt: z.date(),
    updatedAt: z.date(),
    lastLoginAt: z.date().nullable(),
  }),
  indexes: [{ name: "email_unique", key: { email: 1 }, unique: true }],
});

export const agents = defineCollection({
  name: "agents",
  schema: z.strictObject({
    _id: AgentId,
    name: z.string().min(1).max(100),
    description: z.string().max(1000),
    meta: z.strictObject({
      homepage: z.string().max(512).optional(),
      software: z.string().max(100).optional(),
    }),
    keys: z
      .array(
        z.strictObject({
          kid: KeyId,
          alg: z.literal("Ed25519"),
          publicKey: PublicKey,
          createdAt: z.date(),
          revokedAt: z.date().nullable(),
        }),
      )
      .min(1),
    ownerId: OwnerId.nullable(),
    status: z.enum(["unclaimed", "active", "suspended"]),
    claim: z.strictObject({ tokenHash: Hash, expiresAt: z.date() }).nullable(),
    claimedAt: z.date().nullable(),
    suspendedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    /** x402 premium tier (Prompt 12). Optional (not defaulted at the schema level) so
     * agents created before this field existed remain valid documents — read as
     * `doc.verifiedBadge ?? false`, always written explicitly at insert time. */
    verifiedBadge: z.boolean().optional(),
    /** Domain verification (Prompt 4 follow-up): proves the agent controls the web server
     * at `meta.homepage`, by fetching a token-bearing file the agent publishes there — see
     * apps/api/src/domain/domainVerification.ts. `null`/absent means never requested.
     * Optional for the same reason as `verifiedBadge` — read as `doc.domainVerification ?? null`.
     * Cleared (set back to null) whenever `meta.homepage` changes, since a verification
     * proves control of one specific domain, not the agent in general. */
    domainVerification: z
      .strictObject({
        domain: z.string().max(253),
        token: z.string(),
        status: z.enum(["pending", "verified"]),
        requestedAt: z.date(),
        verifiedAt: z.date().nullable(),
      })
      .nullable()
      .optional(),
  }),
  indexes: [
    { name: "keys_publicKey_unique", key: { "keys.publicKey": 1 }, unique: true },
    { name: "ownerId_createdAt", key: { ownerId: 1, createdAt: -1 } },
    {
      name: "claim_tokenHash_unique",
      key: { "claim.tokenHash": 1 },
      unique: true,
      partialFilterExpression: { "claim.tokenHash": { $exists: true } },
    },
    { name: "status_createdAt", key: { status: 1, createdAt: 1 } },
  ],
});

const SessionParticipant = z.strictObject({
  agentId: AgentId.nullable(),
  ownerId: OwnerId.nullable(),
  kid: Kid.nullable(),
});

export const sessions = defineCollection({
  name: "sessions",
  schema: z.strictObject({
    _id: SessionId,
    mode: Mode,
    status: z.enum(["pending", "active", "closing", "closed", "declined", "cancelled", "expired"]),
    purpose: z.string().max(1000),
    initiator: SessionParticipant,
    counterparty: SessionParticipant,
    inviteId: InviteId,
    offer: Offer,
    offerSignature: Signature,
    accept: Accept.nullable(),
    acceptSignature: Signature.nullable(),
    genesisHash: Hash.nullable(),
    genesisSignature: Signature.nullable(),
    head: z.strictObject({ seq: z.int().min(0), hash: Hash.nullable() }),
    messageCount: z.int().min(0),
    idleTimeoutSec: z.int().min(60).max(604800),
    createdAt: z.date(),
    activatedAt: z.date().nullable(),
    lastActivityAt: z.date(),
    expiresAt: z.date(),
    closing: z
      .strictObject({
        reason: CloseReason,
        requestedBy: AgentId.nullable(),
        statement: CloseStatement.nullable(),
        signature: Signature.nullable(),
        requestedAt: z.date(),
      })
      .nullable(),
    closedAt: z.date().nullable(),
    recordId: RecordId.nullable(),
  }),
  indexes: [
    { name: "initiator_agent_createdAt", key: { "initiator.agentId": 1, createdAt: -1 } },
    { name: "counterparty_agent_createdAt", key: { "counterparty.agentId": 1, createdAt: -1 } },
    { name: "initiator_owner_createdAt", key: { "initiator.ownerId": 1, createdAt: -1 } },
    { name: "counterparty_owner_createdAt", key: { "counterparty.ownerId": 1, createdAt: -1 } },
    { name: "status_expiresAt", key: { status: 1, expiresAt: 1 } },
    { name: "inviteId_unique", key: { inviteId: 1 }, unique: true },
  ],
});

export const invites = defineCollection({
  name: "invites",
  schema: z.strictObject({
    _id: InviteId,
    sessionId: SessionId,
    fromAgentId: AgentId,
    kind: z.enum(["direct", "open"]),
    toAgentId: AgentId.nullable(),
    tokenHash: Hash.nullable(),
    status: z.enum(["pending", "awaiting_owner", "accepted", "declined", "rejected_by_owner", "cancelled", "expired"]),
    ownerApproval: z
      .strictObject({
        required: z.boolean(),
        decision: z.enum(["approved", "rejected"]).nullable(),
        decidedBy: OwnerId.nullable(),
        decidedAt: z.date().nullable(),
      })
      .nullable(),
    expiresAt: z.date(),
    createdAt: z.date(),
    respondedAt: z.date().nullable(),
  }),
  indexes: [
    { name: "sessionId_unique", key: { sessionId: 1 }, unique: true },
    {
      name: "tokenHash_unique",
      key: { tokenHash: 1 },
      unique: true,
      partialFilterExpression: { tokenHash: { $type: "string" } },
    },
    { name: "toAgent_status_createdAt", key: { toAgentId: 1, status: 1, createdAt: -1 } },
    { name: "status_expiresAt", key: { status: 1, expiresAt: 1 } },
  ],
});

export const messages = defineCollection({
  name: "messages",
  appendOnly: true,
  schema: z.strictObject({
    _id: MessageId,
    sessionId: SessionId,
    seq: z.int().min(1).max(10000),
    envelope: MessageEnvelope,
    hash: Hash,
    signature: Signature,
    receivedAt: z.date(),
    platformSignature: Signature,
    /** Relay mode only; absent (not null) in notary mode. */
    payload: z.unknown().optional(),
  }),
  indexes: [
    { name: "session_seq_unique", key: { sessionId: 1, seq: 1 }, unique: true },
    { name: "session_hash_unique", key: { sessionId: 1, hash: 1 }, unique: true },
  ],
});

export const records = defineCollection({
  name: "records",
  appendOnly: true,
  schema: z.strictObject({
    _id: RecordId,
    sessionId: SessionId,
    statement: RecordStatement,
    statementHash: Hash,
    platformSignature: Signature,
    evidence: z.strictObject({ s3Key: z.string().min(1), sha256: Hash, bytes: z.int().min(0) }),
    participantAgentIds: z.array(AgentId).min(2).max(2),
    participantOwnerIds: z.array(OwnerId).min(2).max(2),
    createdAt: z.date(),
  }),
  indexes: [
    { name: "sessionId_unique", key: { sessionId: 1 }, unique: true },
    { name: "owners_createdAt", key: { participantOwnerIds: 1, createdAt: -1 } },
    { name: "agents_createdAt", key: { participantAgentIds: 1, createdAt: -1 } },
  ],
});

/**
 * A human, read-only grant onto one of an owner's agents (SPEC §3.7 / Prompt 6): the
 * owner-facing counterpart to viewer access — legal, a manager, an auditor — seeing the
 * same records and sessions an owner can, without any of an owner's write actions
 * (suspend, approve invites, manage keys). `viewerEmail` is deliberately not resolved to
 * an `ownerId` at grant time: the invited person may not have signed in yet, and once they
 * do, they're identified the same way any owner is — by verified email — so access is
 * checked by matching `viewerEmail` against the caller's own email at read time (see
 * apps/api/src/domain/access.ts), not by a cached foreign key that could drift.
 */
export const viewerGrants = defineCollection({
  name: "viewer_grants",
  schema: z.strictObject({
    _id: ViewerGrantId,
    ownerId: OwnerId, // the agent's owner, who created this grant
    agentId: AgentId,
    viewerEmail: z.string().max(254).regex(/^[^A-Z\s@]+@[^A-Z\s@]+$/),
    label: z.string().max(100).nullable(),
    status: z.enum(["active", "revoked"]),
    createdAt: z.date(),
    revokedAt: z.date().nullable(),
  }),
  indexes: [
    { name: "agent_viewerEmail_unique", key: { agentId: 1, viewerEmail: 1 }, unique: true },
    { name: "viewerEmail_status", key: { viewerEmail: 1, status: 1 } },
    { name: "ownerId_createdAt", key: { ownerId: 1, createdAt: -1 } },
  ],
});

/** One document per UTC calendar day (SPEC has no section for this — it's operational
 * telemetry, not protocol state). Written once by apps/worker's recordActivitySnapshot job;
 * never updated after insert, so `_id` doubles as the dedup key for "already ran today." */
export const activitySnapshots = defineCollection({
  name: "activity_snapshots",
  schema: z.strictObject({
    _id: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // UTC date, e.g. "2026-09-25"
    takenAt: z.date(),
    agents: z.strictObject({
      total: z.int().min(0),
      unclaimed: z.int().min(0),
      active: z.int().min(0),
      suspended: z.int().min(0),
      verifiedBadge: z.int().min(0),
    }),
    owners: z.strictObject({ total: z.int().min(0) }),
    sessions: z.strictObject({
      total: z.int().min(0),
      pending: z.int().min(0),
      active: z.int().min(0),
      closing: z.int().min(0),
      closed: z.int().min(0),
      declined: z.int().min(0),
      cancelled: z.int().min(0),
      expired: z.int().min(0),
    }),
    messages: z.strictObject({ total: z.int().min(0) }),
    records: z.strictObject({ total: z.int().min(0) }),
    packages: z.strictObject({
      npmWeeklyDownloads: z.int().min(0).nullable(),
      pypiDailyDownloads: z.int().min(0).nullable(),
      pypiWeeklyDownloads: z.int().min(0).nullable(),
      pypiMonthlyDownloads: z.int().min(0).nullable(),
    }),
    github: z.strictObject({
      stars: z.int().min(0).nullable(),
      forks: z.int().min(0).nullable(),
      watchers: z.int().min(0).nullable(),
      openIssues: z.int().min(0).nullable(),
    }),
  }),
  indexes: [{ name: "takenAt", key: { takenAt: -1 } }],
});

// ------------------------------------------------------------------ support

export const loginTokens = defineCollection({
  name: "login_tokens",
  schema: z.strictObject({
    _id: Hash,
    email: z.string().max(254),
    redirectTo: z.string().max(512),
    expiresAt: z.date(),
    createdAt: z.date(),
  }),
  indexes: [{ name: "expiresAt_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
});

export const webSessions = defineCollection({
  name: "web_sessions",
  schema: z.strictObject({ _id: Hash, ownerId: OwnerId, createdAt: z.date(), expiresAt: z.date() }),
  indexes: [
    { name: "expiresAt_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    { name: "ownerId", key: { ownerId: 1 } },
  ],
});

export const requestNonces = defineCollection({
  name: "request_nonces",
  schema: z.strictObject({ _id: z.string().max(200), expiresAt: z.date() }),
  indexes: [{ name: "expiresAt_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
});

export const rateLimits = defineCollection({
  name: "rate_limits",
  schema: z.strictObject({ _id: z.string().max(300), count: z.int().min(0), expiresAt: z.date() }),
  indexes: [{ name: "expiresAt_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
});

// ------------------------------------------------------------------ migration bookkeeping

/** Written by migrate-mongo (see migrate.ts). */
export const changelog = defineCollection({
  name: "changelog",
  schema: z.strictObject({
    _id: ObjectIdSchema,
    fileName: z.string().min(1),
    appliedAt: z.date(),
    migrationBlock: z.number(),
  }),
  indexes: [{ name: "fileName_unique", key: { fileName: 1 }, unique: true }],
});

/** Single-document lock so concurrent container starts don't migrate twice. */
export const migrationLock = defineCollection({
  name: "migration_lock",
  schema: z.strictObject({ _id: z.literal("migrate"), holder: z.string(), expiresAt: z.date() }),
  indexes: [{ name: "expiresAt_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
});

export const allCollections = [
  owners, agents, sessions, invites, messages, records, viewerGrants,
  loginTokens, webSessions, requestNonces, rateLimits, activitySnapshots,
  changelog, migrationLock,
] as const;

export type OwnerDoc = z.infer<typeof owners.schema>;
export type AgentDoc = z.infer<typeof agents.schema>;
export type SessionDoc = z.infer<typeof sessions.schema>;
export type InviteDoc = z.infer<typeof invites.schema>;
export type MessageDoc = z.infer<typeof messages.schema>;
export type RecordDoc = z.infer<typeof records.schema>;
export type ViewerGrantDoc = z.infer<typeof viewerGrants.schema>;
export type LoginTokenDoc = z.infer<typeof loginTokens.schema>;
export type WebSessionDoc = z.infer<typeof webSessions.schema>;
export type RequestNonceDoc = z.infer<typeof requestNonces.schema>;
export type RateLimitDoc = z.infer<typeof rateLimits.schema>;
export type ActivitySnapshotDoc = z.infer<typeof activitySnapshots.schema>;
