export { OpenGlassClient, type OpenGlassClientOptions, type WaitOptions } from "./client.js";
export type { AgentFull, AgentKeyView, AgentPublic, Invite, Session } from "./client.js";
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
  Signature,
} from "./types.js";
