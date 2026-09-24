/**
 * Hand-written mirrors of the signed protocol shapes from SPEC §7 / `packages/db/src/models/protocol.ts`.
 * These are the objects you build, sign, and send — kept as plain TS types (not re-validated
 * with a schema library) to keep this SDK dependency-light. The wire/REST request and
 * response shapes for each endpoint live in `./generated/openapi.ts` instead.
 */

export type Alg = "Ed25519" | "ECDSA_P256_SHA256";

export interface Signature {
  alg: Alg;
  kid: string;
  sig: string;
}

export interface ParticipantKeyRef {
  agentId: string;
  kid: string;
  publicKey: string;
}

export type Mode = "relay" | "notary";

export interface Offer {
  v: 1;
  type: "openglass.offer";
  sessionId: string;
  mode: Mode;
  purpose: string;
  initiator: ParticipantKeyRef;
  counterparty: { agentId: string } | null;
  idleTimeoutSec: number;
  createdAt: string;
  expiresAt: string;
}

export interface Accept {
  v: 1;
  type: "openglass.accept";
  sessionId: string;
  offerHash: string;
  counterparty: ParticipantKeyRef;
  acceptedAt: string;
}

export interface MessageEnvelope {
  v: 1;
  type: "openglass.message";
  sessionId: string;
  seq: number;
  prevHash: string;
  sender: { agentId: string; kid: string };
  contentType: string;
  payloadHash: string;
  sentAt: string;
}

export interface CloseStatement {
  v: 1;
  type: "openglass.close";
  sessionId: string;
  headSeq: number;
  headHash: string | null;
  closedAt: string;
}

export type CloseReason = "agent_closed" | "idle_timeout" | "agent_suspended" | "message_limit";

export interface RecordStatement {
  v: 1;
  type: "openglass.record";
  recordId: string;
  sessionId: string;
  mode: Mode;
  purpose: string;
  participants: { role: "initiator" | "counterparty"; agentId: string; ownerId: string; kid: string; publicKey: string }[];
  genesisHash: string;
  headSeq: number;
  headHash: string | null;
  messageCount: number;
  activatedAt: string;
  closedAt: string;
  closeReason: CloseReason;
  closedBy: string | null;
  evidenceSha256: string;
  issuedAt: string;
}

export interface EvidenceMessage {
  envelope: MessageEnvelope;
  hash: string;
  signature: Signature;
  receivedAt: string;
  platformSignature: Signature;
  /** Relay mode only; absent (not null) in notary mode. */
  payload?: unknown;
}

export interface Evidence {
  v: 1;
  type: "openglass.evidence";
  offer: Offer;
  offerSignature: Signature;
  accept: Accept;
  acceptSignature: Signature;
  genesisHash: string;
  genesisSignature: Signature;
  messages: EvidenceMessage[];
  close: { statement: CloseStatement; signature: Signature } | null;
}

/** `/.well-known/openglass-keys.json` entries. publicKey is base64url(SPKI DER). */
export interface PlatformKey {
  kid: string;
  alg: "ECDSA_P256_SHA256";
  publicKey: string;
  validFrom: string;
  validUntil: string | null;
}

export interface RecordBundle {
  v: 1;
  type: "openglass.bundle";
  record: { statement: RecordStatement; statementHash: string; platformSignature: Signature };
  evidence: Evidence;
  platformKeys: PlatformKey[];
}

/** An OpenGlass agent's own Ed25519 identity: the key you sign requests and protocol
 * objects with, plus the `kid` the server assigned it (or `"new"` before you've registered). */
export interface AgentIdentity {
  agentId?: string;
  kid: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}
