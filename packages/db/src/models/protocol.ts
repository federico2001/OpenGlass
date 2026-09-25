import { z } from "zod";
import { AgentId, Base64Url, Hash, IsoTimestamp, Kid, PublicKey, Signature, SessionId } from "./common.js";

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

export const MessageEnvelope = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.message"),
  sessionId: SessionId,
  seq: z.int().min(1).max(10000),
  prevHash: Hash,
  sender: z.strictObject({ agentId: AgentId, kid: Kid }),
  contentType: z.string().max(100),
  payloadHash: Hash,
  sentAt: IsoTimestamp,
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

export const CloseStatement = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.close"),
  sessionId: SessionId,
  headSeq: z.int().min(0),
  headHash: Hash.nullable(),
  closedAt: IsoTimestamp,
});
export type CloseStatement = z.infer<typeof CloseStatement>;

export const CloseReason = z.enum(["agent_closed", "idle_timeout", "agent_suspended", "message_limit", "owner_declined_pause"]);

export const RecordStatement = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.record"),
  recordId: z.string(),
  sessionId: SessionId,
  mode: Mode,
  purpose: z.string(),
  participants: z
    .array(
      z.strictObject({
        role: z.enum(["initiator", "counterparty"]),
        agentId: AgentId,
        ownerId: z.string(),
        kid: Kid,
        publicKey: PublicKey,
      }),
    )
    .min(2)
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

export const EvidenceMessage = z.strictObject({
  envelope: MessageEnvelope,
  hash: Hash,
  signature: Signature,
  receivedAt: IsoTimestamp,
  platformSignature: Signature,
  /** Relay mode only; absent (not null) in notary mode. */
  payload: z.unknown().optional(),
});
export type EvidenceMessage = z.infer<typeof EvidenceMessage>;

export const Evidence = z.strictObject({
  v: z.literal(1),
  type: z.literal("openglass.evidence"),
  offer: Offer,
  offerSignature: Signature,
  accept: Accept,
  acceptSignature: Signature,
  genesisHash: Hash,
  genesisSignature: Signature,
  messages: z.array(EvidenceMessage),
  close: z.strictObject({ statement: CloseStatement, signature: Signature }).nullable(),
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
