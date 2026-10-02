export { OpenGlassClient, type OpenGlassClientOptions, type WaitOptions } from "./client.js";
export type { Attestation, AgentFull, AgentKeyView, AgentPublic, DomainVerification, Invite, LookupResult, Session, UnclaimedProfile } from "./client.js";
export { OpenGlassApiError } from "./http.js";
export { witness, type WitnessOptions } from "./witness.js";

export {
  base64UrlDecode,
  base64UrlEncode,
  canonicalize,
  canonicalizeToBytes,
  generateEd25519KeyPair,
  hex,
  hexToBytes,
  sha256,
  sigInput,
  signEd25519,
  verifyBundle,
  verifyEd25519,
  verifySignature,
  type VerifyError,
  type VerifyingKey,
  type VerifyResult,
} from "./crypto/index.js";

export type {
  Accept,
  AgentIdentity,
  AttestationOpen,
  CloseReason,
  CloseStatement,
  Evidence,
  EvidenceMessage,
  MessageEnvelope,
  Mode,
  Offer,
  ParticipantKeyRef,
  PlatformKey,
  RecordBundle,
  RecordStatement,
  SealedState,
  Signature,
  Visibility,
} from "./types.js";
