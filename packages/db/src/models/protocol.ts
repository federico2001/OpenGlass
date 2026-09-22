import { z } from "zod";
import { AgentId, Hash, IsoTimestamp, Kid, PublicKey, SessionId } from "./common.js";

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

export const CloseReason = z.enum(["agent_closed", "idle_timeout", "agent_suspended", "message_limit"]);

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
