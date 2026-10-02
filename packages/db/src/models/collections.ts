import { z } from "zod";
import {
  AgentId, AttestationId, ChainSubjectId, Hash, IntegrationRequestId, IntegrationVoteId, InviteId, KeyId, MessageId,
  ObjectIdSchema, OwnerId, PublicKey, RecordId, SessionId, Signature, Kid, ViewerAccessLogId, ViewerGrantId,
} from "./common.js";
import { Accept, AttestationOpen, CloseReason, CloseStatement, MessageEnvelope, Mode, Offer, RecordRetention, RecordStatement } from "./protocol.js";
import { defineCollection } from "./define.js";

// Document shapes follow docs/SPEC.md §3.

/** Realignment R1 (docs/SPEC.md §13): `private | sealed | shared`, chosen by the
 * offering/opening agent (a sibling request-body field, not part of the signed
 * offer/open object — same pattern `idleTimeoutSec` already uses for attestations).
 * Optional/absent on `sessions`/`attestations` means "issued before this field
 * existed" — those keep behaving exactly as they always have (full content, no sealing),
 * never retroactively reinterpreted as any of the three named values. */
const Visibility = z.enum(["private", "sealed", "shared"]);

export const owners = defineCollection({
  name: "owners",
  schema: z.strictObject({
    _id: OwnerId,
    email: z.string().max(254).regex(/^[^A-Z\s@]+@[^A-Z\s@]+$/),
    displayName: z.string().max(100).nullable(),
    settings: z.strictObject({
      requireInviteApproval: z.boolean(),
      emailOnRecord: z.boolean(),
      /** Prompt 13 (public live feed): opts every relay-mode session this owner
       * participates in into the public feed, once the *other* owner also opts in.
       * Optional so existing owner documents remain valid — read as `?? false`. */
      publicFeedOptIn: z.boolean().optional(),
      /** Realignment R4 (docs/SPEC.md §15): email alerts for a new counterparty, an
       * unverified counterparty, a high-risk attested action, or a dispute raised — see
       * apps/api/src/domain/alerts.ts. Optional/absent means on (`?? true`) — an
       * oversight feature that ships opt-out, unlike `publicFeedOptIn` above which ships
       * opt-in, since staying silent by default would undercut the whole point of "owner
       * dashboard as oversight". */
      oversightAlerts: z.boolean().optional(),
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
    /** Owner-set spend cap on this agent's own x402 premium purchases (Prompt 6 follow-up),
     * in US cents. `null`/absent = no limit. Optional for the same reason as `verifiedBadge`
     * — read as `doc.spendLimitUsdCents ?? null`. Deliberately lifetime-cumulative, not a
     * rolling window — enough to stop an agent from spending unboundedly without needing a
     * reset schedule to get right in v1. */
    spendLimitUsdCents: z.int().min(0).nullable().optional(),
    /** Lifetime total of this agent's own x402 premium spend, in US cents. Optional/read as
     * `doc.totalSpendUsdCents ?? 0` for the same pre-existing-document reason. Only ever
     * incremented for a request the agent itself (not its owner) authenticated. */
    totalSpendUsdCents: z.int().min(0).optional(),
    /** Prompt 13 (public directory): owner-controlled, not agent-controlled — the human
     * decides what's publicly discoverable about their own agent, not the agent itself.
     * Optional so existing agent documents remain valid — read as `?? false`. */
    publicDirectory: z.boolean().optional(),
    /** Realignment R1 (docs/SPEC.md §13): how long this agent's `visibility: "private"`
     * records are kept before crypto-shredding, in days. `null`/absent = the platform
     * default (see apps/api's `DEFAULT_PRIVATE_RETENTION_DAYS`). Owner-set via
     * `PATCH /v1/owner/agents/{id}/retention`. Only ever governs *new* records issued
     * after it's set — an already-issued record's retention was captured once, in its own
     * signed statement, at issuance time, and never changes underneath it. */
    privateRetentionDays: z.int().min(1).max(3650).nullable().optional(),
    /** Realignment R2 (docs/SPEC.md §14): `domainFromHomepage(meta.homepage)`, kept in
     * sync (written alongside `meta`, cleared alongside `domainVerification` whenever
     * `meta.homepage` changes) purely so `GET /v1/lookup?domain=` can query it directly
     * instead of scanning every agent and re-parsing `meta.homepage` in application code.
     * Never itself a claim of ownership — `domainVerification.status === "verified"` is
     * the only thing that is; this just makes an *unverified* homepage domain findable
     * too, so a lookup can report "claims this domain, unverified" instead of a false
     * not_found for an agent that exists but hasn't proven it yet. */
    homepageDomain: z.string().max(253).nullable().optional(),
    /** Realignment R4 (docs/SPEC.md §13/§15): owner-set per-agent default for
     * `visibility` when a session/attestation-open request omits it — read by
     * apps/api/src/domain/visibility.ts's `effectiveVisibility` ahead of the hardcoded
     * platform default (sealed for sessions, private for attestations). `null`/absent
     * means "use the platform default", not "shared" — this never widens exposure by
     * itself. Owner-set via `PATCH /v1/owner/agents/{id}/visibility-default`. */
    defaultVisibility: Visibility.nullable().optional(),
  }),
  indexes: [
    { name: "keys_publicKey_unique", key: { "keys.publicKey": 1 }, unique: true },
    { name: "ownerId_createdAt", key: { ownerId: 1, createdAt: -1 } },
    { name: "directory", key: { publicDirectory: 1, status: 1 } },
    {
      name: "claim_tokenHash_unique",
      key: { "claim.tokenHash": 1 },
      unique: true,
      partialFilterExpression: { "claim.tokenHash": { $exists: true } },
    },
    { name: "status_createdAt", key: { status: 1, createdAt: 1 } },
    { name: "homepageDomain", key: { homepageDomain: 1 }, partialFilterExpression: { homepageDomain: { $type: "string" } } },
    {
      name: "domainVerification_verified",
      key: { "domainVerification.domain": 1 },
      partialFilterExpression: { "domainVerification.status": "verified" },
    },
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
    status: z.enum(["pending", "active", "paused", "closing", "closed", "declined", "cancelled", "expired"]),
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
    visibility: Visibility.optional(),
    // Prompt 6: an agent can pause an active session pending its owner's (or the
    // counterparty's owner's) explicit go-ahead before it continues — e.g. before a
    // spend-limit-adjacent or otherwise consequential exchange. Cleared on resume;
    // moves the session to `closing` (reason `owner_declined_pause`) on decline.
    pause: z
      .strictObject({
        requestedBy: AgentId,
        reason: z.string().max(1000),
        requestedAt: z.date(),
      })
      .nullable(),
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

/** Prompt 20: one-party attestation — an agent's own signed, hash-chained, platform-
 * countersigned record of a sequence of events, with no counterparty to accept. No
 * `invites`/`offer`/`accept`: activates immediately on open (there's no one else who
 * needs to agree). Everything downstream (events, close, record issuance, verification)
 * reuses the same mechanisms as a session — see the field-reuse notes in protocol.ts. */
export const attestations = defineCollection({
  name: "attestations",
  schema: z.strictObject({
    _id: AttestationId,
    mode: Mode,
    status: z.enum(["active", "closing", "closed"]),
    purpose: z.string().max(1000),
    attestor: z.strictObject({ agentId: AgentId, ownerId: OwnerId, kid: Kid }),
    open: AttestationOpen,
    openSignature: Signature,
    genesisHash: Hash,
    genesisSignature: Signature,
    head: z.strictObject({ seq: z.int().min(0), hash: Hash.nullable() }),
    eventCount: z.int().min(0),
    idleTimeoutSec: z.int().min(60).max(604800),
    createdAt: z.date(),
    activatedAt: z.date(),
    lastActivityAt: z.date(),
    expiresAt: z.date(),
    visibility: Visibility.optional(),
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
    { name: "attestor_agent_createdAt", key: { "attestor.agentId": 1, createdAt: -1 } },
    { name: "attestor_owner_createdAt", key: { "attestor.ownerId": 1, createdAt: -1 } },
    { name: "status_expiresAt", key: { status: 1, expiresAt: 1 } },
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
    /** Holds an attestation id for an attestation's events (Prompt 20) — see the
     * field-reuse note on `MessageEnvelope` in protocol.ts. Same collection, same
     * indexes, same append-only rules either way. */
    sessionId: ChainSubjectId,
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
    /** Holds an attestation id when `statement.kind === "attestation"` — see the
     * field-reuse note on `RecordStatement` in protocol.ts. */
    sessionId: ChainSubjectId,
    statement: RecordStatement,
    statementHash: Hash,
    platformSignature: Signature,
    evidence: z.strictObject({ s3Key: z.string().min(1), sha256: Hash, bytes: z.int().min(0) }),
    /** 2 for a session record, 1 for an attestation record. */
    participantAgentIds: z.array(AgentId).min(1).max(2),
    participantOwnerIds: z.array(OwnerId).min(1).max(2),
    createdAt: z.date(),
    /** Realignment R1 (docs/SPEC.md §13): mirrors `statement.visibility`, duplicated here
     * (not just read out of the signed statement) so routes/jobs can query/index on it
     * without deserializing `statement`. Optional/absent means "issued before this field
     * existed" — treated as `shared`, matching legacy behavior. */
    visibility: Visibility.optional(),
    /** `sealed`-visibility lifecycle (SPEC §13.2). Absent for `shared`/`private` records —
     * `shared` has nothing to seal, and `private` uses `encryption`/retention instead of a
     * mutual-consent ceremony. `approvals` collects owner ids that have consented to
     * unseal; `unsealed` is reached once both participant owners are present (or a
     * `disputed` record is force-unsealed for fairness, per SPEC §13.2). */
    sealedState: z
      .strictObject({
        status: z.enum(["sealed", "unseal_requested", "unsealed", "disputed"]),
        requestedBy: OwnerId.nullable(),
        approvals: z.array(OwnerId),
        unsealedAt: z.date().nullable(),
        disputedBy: OwnerId.nullable(),
        disputedAt: z.date().nullable(),
      })
      .nullable()
      .optional(),
    /** A participant owner's dispute of this record (docs/SPEC.md §13.2). A flag, set once
     * by the first owner to dispute, on any visibility; it opens nothing by itself. Never
     * part of `statement`/`evidence`, so setting it doesn't touch anything a signature or
     * hash covers. Legacy `sealed` records also record the dispute in `sealedState`, which
     * still force-unseals them (the rule they were issued under). */
    dispute: z
      .strictObject({
        disputedBy: OwnerId,
        disputedAt: z.date(),
      })
      .nullable()
      .optional(),
    /** `private`-visibility only. Mirrors `statement.retention` (itself platform-signed at
     * issuance so a record's declared expiry is tamper-evident) as a native `Date` — unlike
     * the signed statement's ISO-string copy, this one is never hashed/signed, so it can use
     * the same `z.date()` convention as every other Mongo-stored timestamp in this file, and
     * exists purely so `shredExpiredPrivateRecords` can index/query on `retention.expiresAt`
     * without touching `statement`. */
    retention: z
      .strictObject({
        days: z.int().min(1).max(3650),
        expiresAt: z.date(),
      })
      .nullable()
      .optional(),
    /** `private`-visibility only: the envelope-encryption state for this record's relay
     * payloads (docs/SPEC.md §13.3). `dataKeyCiphertext` is the record's AES-256 data key,
     * wrapped by the platform's long-lived KMS/local master key (see
     * `packages/db/src/crypto/contentEncryption.ts`) — never the plaintext key. Crypto-
     * shredding (`records.ts`'s `shredContent`, the one deliberate exception to this
     * collection's append-only rule) nulls out `dataKeyCiphertext` and sets `shredded: true`
     * — nothing else in this document, or in the immutable S3 evidence it points at, ever
     * changes, so `evidenceSha256`/the platform's signature stay valid forever regardless of
     * shred status. */
    encryption: z
      .strictObject({
        dataKeyCiphertext: z.string().min(1).nullable(),
        /** Null when the data key was wrapped by a local dev-only master key
         * (CONTENT_ENCRYPTION=local) rather than a real KMS CMK — there's no key id to
         * record in that mode. */
        kmsKeyId: z.string().min(1).nullable(),
        shredded: z.boolean(),
        shreddedAt: z.date().nullable(),
        shreddedReason: z.enum(["retention_expired", "owner_deleted"]).nullable(),
      })
      .nullable()
      .optional(),
  }),
  indexes: [
    { name: "sessionId_unique", key: { sessionId: 1 }, unique: true },
    { name: "owners_createdAt", key: { participantOwnerIds: 1, createdAt: -1 } },
    { name: "agents_createdAt", key: { participantAgentIds: 1, createdAt: -1 } },
    {
      name: "shreddable_expiresAt",
      key: { "retention.expiresAt": 1 },
      partialFilterExpression: { "encryption.shredded": false, "retention.expiresAt": { $type: "date" } },
    },
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
    /** Realignment R4 (docs/SPEC.md §15). Optional/absent means "read" — every grant
     * created before this field existed keeps exactly its original (read-only) behavior.
     * "read": list/view sessions, attestations, and record summaries. "export": read,
     * plus download a record's full verifiable bundle (GET .../bundle) — a real step up,
     * since the bundle carries the full evidence, not just that a session happened.
     * "manage" is reserved: stored and shown in the dashboard, but doesn't yet grant any
     * write capability beyond export — see docs/SPEC.md §15 before relying on it for
     * anything more than read/export. */
    scope: z.enum(["read", "export", "manage"]).optional(),
  }),
  indexes: [
    { name: "agent_viewerEmail_unique", key: { agentId: 1, viewerEmail: 1 }, unique: true },
    { name: "viewerEmail_status", key: { viewerEmail: 1, status: 1 } },
    { name: "ownerId_createdAt", key: { ownerId: 1, createdAt: -1 } },
  ],
});

/** Realignment R4 (docs/SPEC.md §15): "an audit log of who viewed what" — one row per
 * read a viewer-grant holder (never the owner/agent themselves, who don't need auditing
 * on their own data) makes against a granted agent's sessions/attestations/records.
 * Append-only in spirit (a log entry is never edited or deleted once written) even
 * though it isn't marked `appendOnly: true` here — unlike `messages`/`records`, nothing
 * about this collection's integrity depends on a hash chain or a signature, so the
 * stricter enforced-in-code guarantee (D12) isn't needed; ordinary insert-only
 * application code is enough. */
export const viewerAccessLog = defineCollection({
  name: "viewer_access_log",
  schema: z.strictObject({
    _id: ViewerAccessLogId,
    ownerId: OwnerId, // whose data was viewed — lets that owner query "who's been looking at my stuff"
    agentId: AgentId,
    viewerEmail: z.string().max(254),
    action: z.enum(["list_sessions", "list_attestations", "list_records", "view_record_bundle"]),
    resourceId: z.string().nullable(), // a session/attestation/record id for a single-resource action; null for a list
    at: z.date(),
  }),
  indexes: [{ name: "ownerId_agentId_at", key: { ownerId: 1, agentId: 1, at: -1 } }],
});

/** Prompt 23: the public `/integrations` request board. The framework catalog itself
 * (name, description, links) is a static YAML file (apps/api/data/integrations.yaml),
 * not a collection — these three collections hold only what's actually dynamic: an
 * admin-set status override per framework slug, one vote per (slug, owner), and
 * "request my framework" submissions. */
export const integrationStatusOverrides = defineCollection({
  name: "integration_status",
  schema: z.strictObject({
    _id: z.string().min(1).max(100), // the catalog entry's own slug
    status: z.enum(["requested", "in_progress", "available", "native"]),
    updatedAt: z.date(),
    updatedBy: OwnerId,
  }),
  indexes: [],
});

export const integrationVotes = defineCollection({
  name: "integration_votes",
  schema: z.strictObject({
    _id: IntegrationVoteId,
    slug: z.string().min(1).max(100),
    ownerId: OwnerId,
    createdAt: z.date(),
  }),
  indexes: [
    { name: "slug_owner_unique", key: { slug: 1, ownerId: 1 }, unique: true },
    { name: "slug_createdAt", key: { slug: 1, createdAt: -1 } },
  ],
});

export const integrationRequests = defineCollection({
  name: "integration_requests",
  schema: z.strictObject({
    _id: IntegrationRequestId,
    frameworkName: z.string().min(1).max(200),
    frameworkUrl: z.string().max(500).nullable(),
    note: z.string().max(1000).nullable(),
    ownerId: OwnerId,
    requesterEmail: z.string().max(254),
    status: z.enum(["new", "reviewed"]),
    createdAt: z.date(),
  }),
  indexes: [{ name: "status_createdAt", key: { status: 1, createdAt: -1 } }],
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

// ------------------------------------------------------------------ unclaimed profiles

/** docs/SPEC.md §16: a domain an agent on OpenGlass has looked up and found unregistered,
 * listed so its operator can find and claim it. Keyed by the bare hostname. Holds only
 * what the platform fetched or computed itself (never a caller-supplied name or claim),
 * per CLAUDE.md's "Profiles show verifiable facts only". Claimed when an agent proves
 * control of the domain through domain verification. */
export const unclaimedProfiles = defineCollection({
  name: "unclaimed_profiles",
  schema: z.strictObject({
    _id: z.string().min(1).max(253),
    /** Where the platform itself found an agent card for this domain, or null. */
    agentCardUrl: z.string().max(2048).nullable(),
    /** sha256 of the card bytes as fetched, so a later reader can tell whether it changed. */
    cardSha256: Hash.nullable(),
    cardFetchedAt: z.date().nullable(),
    listedBy: AgentId,
    listedAt: z.date(),
    lastSeenAt: z.date(),
    claimedAgentId: AgentId.nullable(),
    claimedAt: z.date().nullable(),
  }),
  indexes: [
    { name: "listedAt", key: { listedAt: -1 } },
    { name: "claimedAgentId", key: { claimedAgentId: 1 }, partialFilterExpression: { claimedAgentId: { $type: "string" } } },
  ],
});

// ------------------------------------------------------------------ apps/checkup

/** Agent Checkup (apps/checkup): one report per check actually run. Also the 1-hour result
 * cache (the newest report for a `targetKey` younger than an hour is served again). */
export const checkupReports = defineCollection({
  name: "checkup_reports",
  schema: z.strictObject({
    _id: z.string().regex(/^chk_[0-9A-HJKMNP-TV-Z]{26}$/),
    targetKey: z.string().min(1).max(2048),
    /** The full JSON report as returned to the caller. */
    report: z.record(z.string(), z.unknown()),
    attestationId: AttestationId.nullable(),
    recordId: RecordId.nullable(),
    createdAt: z.date(),
    expiresAt: z.date(),
  }),
  indexes: [
    { name: "targetKey_createdAt", key: { targetKey: 1, createdAt: -1 } },
    { name: "expiresAt_ttl", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
});

/** Agent Checkup metrics: one row per countable event. Raw rows, aggregated on read by the
 * admin page; nothing here identifies a caller beyond the coarse `source` class. */
export const checkupEvents = defineCollection({
  name: "checkup_events",
  schema: z.strictObject({
    _id: ObjectIdSchema,
    kind: z.enum(["check_run", "cache_hit", "report_open", "claim_click", "unclaimed_listed"]),
    /** `registry` for A2A Registry probes (by user-agent), `user` otherwise. */
    source: z.enum(["user", "registry"]),
    targetKey: z.string().max(2048).nullable(),
    reportId: z.string().max(64).nullable(),
    at: z.date(),
  }),
  indexes: [
    { name: "kind_at", key: { kind: 1, at: -1 } },
    { name: "kind_targetKey", key: { kind: 1, targetKey: 1 } },
  ],
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
  owners, agents, sessions, attestations, invites, messages, records, viewerGrants, viewerAccessLog,
  integrationStatusOverrides, integrationVotes, integrationRequests,
  loginTokens, webSessions, requestNonces, rateLimits, activitySnapshots,
  unclaimedProfiles, checkupReports, checkupEvents,
  changelog, migrationLock,
] as const;

export type OwnerDoc = z.infer<typeof owners.schema>;
export type AgentDoc = z.infer<typeof agents.schema>;
export type SessionDoc = z.infer<typeof sessions.schema>;
export type AttestationDoc = z.infer<typeof attestations.schema>;
export type InviteDoc = z.infer<typeof invites.schema>;
export type MessageDoc = z.infer<typeof messages.schema>;
export type RecordDoc = z.infer<typeof records.schema>;
export type UnclaimedProfileDoc = z.infer<typeof unclaimedProfiles.schema>;
export type CheckupReportDoc = z.infer<typeof checkupReports.schema>;
export type CheckupEventDoc = z.infer<typeof checkupEvents.schema>;
export type ViewerGrantDoc = z.infer<typeof viewerGrants.schema>;
export type ViewerAccessLogDoc = z.infer<typeof viewerAccessLog.schema>;
export type IntegrationStatusOverrideDoc = z.infer<typeof integrationStatusOverrides.schema>;
export type IntegrationVoteDoc = z.infer<typeof integrationVotes.schema>;
export type IntegrationRequestDoc = z.infer<typeof integrationRequests.schema>;
export type LoginTokenDoc = z.infer<typeof loginTokens.schema>;
export type WebSessionDoc = z.infer<typeof webSessions.schema>;
export type RequestNonceDoc = z.infer<typeof requestNonces.schema>;
export type RateLimitDoc = z.infer<typeof rateLimits.schema>;
export type ActivitySnapshotDoc = z.infer<typeof activitySnapshots.schema>;
