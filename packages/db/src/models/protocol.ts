import { z } from "zod";
import { AgentId, AttestationId, Base64Url, ChainSubjectId, Hash, IsoTimestamp, Kid, PublicKey, Signature, SessionId } from "./common.js";

// Signed protocol objects (SPEC §7). Stored exactly as signed.

const ParticipantKeyRef = z.strictObject({ agentId: AgentId, kid: Kid, publicKey: PublicKey });
export const Mode = z.enum(["relay", "notary"]);

export const Offer = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.offer"),
  sessionId: SessionId,
  mode: Mode,
  purpose: z.string().max(1000),
  initiator: ParticipantKeyRef,
  counterparty: z.strictObject({ agentId: AgentId }).nullable(),
  idleTimeoutSec: z.int().min(60).max(604800),
  createdAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
});
export type Offer = z.infer<typeof Offer>;

export const Accept = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.accept"),
  sessionId: SessionId,
  offerHash: Hash,
  counterparty: ParticipantKeyRef,
  acceptedAt: IsoTimestamp,
});
export type Accept = z.infer<typeof Accept>;

/** Prompt 20: a one-party attestation's opening statement — the counterpart to
 * offer+accept, but for a single attestor with no counterparty to accept. Its own hash,
 * platform-countersigned, becomes the attestation's genesisHash the same way a session's
 * genesis derives from {offer, offerSignature, accept, acceptSignature}. */
export const AttestationOpen = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.attestation_open"),
  attestationId: AttestationId,
  mode: Mode,
  purpose: z.string().max(1000),
  attestor: ParticipantKeyRef,
  createdAt: IsoTimestamp,
});
export type AttestationOpen = z.infer<typeof AttestationOpen>;

/** `sessionId` here is reused across both entity kinds (see `ChainSubjectId` in
 * common.ts) — for an attestation event it holds the attestation's id, not a session's.
 * This is what lets attestation events reuse the exact same hash-chain code path
 * (apps/api/src/domain/chain.ts) and `messages` collection/repository as session
 * messages, and it's the mechanism specified by "reuse the session bundle format so
 * verify() works unchanged." */
export const MessageEnvelope = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.message"),
  sessionId: ChainSubjectId,
  seq: z.int().min(1).max(10000),
  prevHash: Hash,
  sender: z.strictObject({ agentId: AgentId, kid: Kid }),
  contentType: z.string().max(100),
  payloadHash: Hash,
  sentAt: IsoTimestamp,
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

/** `sessionId`: see the note on `MessageEnvelope` — reused for attestations too. */
export const CloseStatement = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.close"),
  sessionId: ChainSubjectId,
  headSeq: z.int().min(0),
  headHash: Hash.nullable(),
  closedAt: IsoTimestamp,
});
export type CloseStatement = z.infer<typeof CloseStatement>;

export const CloseReason = z.enum(["agent_closed", "idle_timeout", "agent_suspended", "message_limit", "owner_declined_pause"]);

/** Realignment R1: a record's declared retention, platform-signed as part of the
 * statement so it's tamper-evident — a verifier can trust "this record was always going
 * to expire on `expiresAt`" as an inherent property, not a mutable fact someone could
 * change after issuance. Present only when `visibility === "private"`. */
export const RecordRetention = z.strictObject({
  days: z.int().min(1).max(3650),
  expiresAt: IsoTimestamp,
});
export type RecordRetention = z.infer<typeof RecordRetention>;

/** `kind` discriminates a two-party session record from a one-party attestation record.
 * Optional and defaulting to "session" (`statement.kind ?? "session"`) so every record
 * issued before this field existed remains byte-identical and still verifies — `kind`
 * itself is never retroactively added to an already-signed, already-hashed statement.
 * `sessionId`: see the note on `MessageEnvelope` — holds the attestation id when
 * `kind === "attestation"`. `participants` has exactly 1 entry (role "attestor") for an
 * attestation, 2 (initiator/counterparty) for a session.
 *
 * `visibility`/`retention` (realignment R1, docs/SPEC.md §13): same optional-and-absent-
 * means-legacy pattern as `kind` — a record issued before this feature existed has
 * neither field, and its bundle keeps behaving exactly as it always has (full content,
 * durable storage). `visibility` is never retroactively added to an existing statement. */
export const RecordStatement = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.record"),
  kind: z.enum(["session", "attestation"]).optional(),
  visibility: z.enum(["private", "sealed", "shared"]).optional(),
  retention: RecordRetention.nullable().optional(),
  recordId: z.string(),
  sessionId: ChainSubjectId,
  mode: Mode,
  purpose: z.string(),
  participants: z
    .array(
      z.strictObject({
        role: z.enum(["initiator", "counterparty", "attestor"]),
        agentId: AgentId,
        ownerId: z.string(),
        kid: Kid,
        publicKey: PublicKey,
      }),
    )
    .min(1)
    .max(2),
  genesisHash: Hash,
  headSeq: z.int().min(0),
  headHash: Hash.nullable(),
  messageCount: z.int().min(0),
  activatedAt: IsoTimestamp,
  closedAt: IsoTimestamp,
  closeReason: CloseReason,
  closedBy: AgentId.nullable(),
  evidenceSha256: Hash,
  issuedAt: IsoTimestamp,
});
export type RecordStatement = z.infer<typeof RecordStatement>;

// §7.4-7.5: the evidence bundle and its wrapper. Not stored documents — these are
// wire/verification shapes (evidence.json in S3, and the downloadable record bundle).

/** Realignment R1: an encrypted Relay payload — `payload` holds this shape instead of
 * the plaintext value for a `visibility: "private"` record. AES-256-GCM, keyed by the
 * record's own per-record data key (see crypto/contentEncryption.ts). Never agent-
 * controlled content — only ever written by the platform at record-issuance time, which
 * is what lets `contentState` (below) be trusted without needing its own signature: any
 * change to it changes `evidenceSha256`, which the platform signature already covers. */
export const EncryptedPayload = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.encrypted-payload"),
  ciphertext: Base64Url,
  iv: Base64Url,
  authTag: Base64Url,
});
export type EncryptedPayload = z.infer<typeof EncryptedPayload>;

export const EvidenceMessage = z.strictObject({
  envelope: MessageEnvelope,
  hash: Hash,
  signature: Signature,
  receivedAt: IsoTimestamp,
  platformSignature: Signature,
  /** Relay mode only; absent (not null) in notary mode. */
  payload: z.unknown().optional(),
  /** Realignment R1: absent/"plain" (the only state before this feature existed) means
   * `payload` is the plaintext value, exactly as today. "encrypted" means `payload` is an
   * `EncryptedPayload` blob instead — only ever set alongside `visibility: "private"` on
   * the enclosing record. There is no "shredded" value: crypto-shredding deletes the
   * record's data-key ciphertext (a separate, mutable field on the `records` Mongo doc),
   * never rewrites this stored evidence — so `contentState` and `evidenceSha256` both
   * stay exactly as issued forever, whether or not the content is still decryptable. */
  contentState: z.enum(["plain", "encrypted"]).optional(),
});
export type EvidenceMessage = z.infer<typeof EvidenceMessage>;

/** `offer`/`accept` (session) and `open` (attestation) are mutually exclusive — exactly
 * one pair is populated, matching the evidence's `kind` (there's no separate `kind` field
 * here; it's implied by which pair is non-null, checked below). Both pairs are nullable
 * rather than the evidence object taking two different shapes, so `verifyBundle` and the
 * SDKs' `verify()` keep one fixed parameter shape regardless of kind. */
export const Evidence = z
  .strictObject({
    v: z.literal(1),
    type: z.literal("openglass.evidence"),
    offer: Offer.nullable(),
    offerSignature: Signature.nullable(),
    accept: Accept.nullable(),
    acceptSignature: Signature.nullable(),
    open: AttestationOpen.nullable(),
    openSignature: Signature.nullable(),
    genesisHash: Hash,
    genesisSignature: Signature,
    messages: z.array(EvidenceMessage),
    close: z.strictObject({ statement: CloseStatement, signature: Signature }).nullable(),
  })
  .superRefine((e, ctx) => {
    const isSession = e.offer !== null;
    const isAttestation = e.open !== null;
    if (isSession === isAttestation) {
      ctx.addIssue({ code: "custom", message: "exactly one of offer or open must be set" });
      return;
    }
    if (isSession && (e.accept === null || e.offerSignature === null || e.acceptSignature === null)) {
      ctx.addIssue({ code: "custom", message: "session evidence requires offerSignature, accept, and acceptSignature" });
    }
    if (isAttestation && e.openSignature === null) {
      ctx.addIssue({ code: "custom", message: "attestation evidence requires openSignature" });
    }
  });
export type Evidence = z.infer<typeof Evidence>;

/** `/.well-known/openglass-keys.json` entries. publicKey is base64url(SPKI DER). */
export const PlatformKey = z.strictObject({
  kid: Kid,
  alg: z.literal("ECDSA_P256_SHA256"),
  publicKey: Base64Url,
  validFrom: IsoTimestamp,
  validUntil: IsoTimestamp.nullable(),
});
export type PlatformKey = z.infer<typeof PlatformKey>;

export const RecordBundle = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.bundle"),
  record: z.strictObject({
    statement: RecordStatement,
    statementHash: Hash,
    platformSignature: Signature,
  }),
  evidence: Evidence,
  platformKeys: z.array(PlatformKey),
});
export type RecordBundle = z.infer<typeof RecordBundle>;
