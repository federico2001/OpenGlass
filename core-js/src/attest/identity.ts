import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { base64UrlDecode, base64UrlEncode, generateEd25519KeyPair, type AgentIdentity } from "openglass-sdk";

interface StoredIdentity {
  agentId?: string;
  kid: string;
  privateKey: string;
  publicKey: string;
}

/**
 * Loads an Ed25519 identity from a local JSON file, generating and persisting a fresh
 * one on first use. This is "key storage" in the sense SPEC D13 means for a local
 * integration: the private key lives in this process (and this one file), never on
 * OpenGlass's servers and never over the network except as a signature.
 *
 * Not a secrets vault — if your deployment needs one (KMS, Vault, etc.), read the key
 * from there yourself and construct an `AgentIdentity` directly; this helper is the
 * zero-config default for the common case of one process on one machine.
 */
export function loadOrCreateIdentity(path: string): AgentIdentity {
  if (existsSync(path)) return readIdentity(path);
  const { privateKey, publicKey } = generateEd25519KeyPair();
  const identity: AgentIdentity = { kid: "new", privateKey, publicKey };
  persistIdentity(path, identity);
  return identity;
}

export function readIdentity(path: string): AgentIdentity {
  const stored = JSON.parse(readFileSync(path, "utf8")) as StoredIdentity;
  return {
    agentId: stored.agentId,
    kid: stored.kid,
    // base64UrlDecode returns a Node Buffer; normalize to a plain Uint8Array so callers
    // (and tests) see the same concrete type generateEd25519KeyPair() produces.
    privateKey: new Uint8Array(base64UrlDecode(stored.privateKey)),
    publicKey: new Uint8Array(base64UrlDecode(stored.publicKey)),
  };
}

/** Call this again after registration to persist the server-assigned `agentId`/`kid`. */
export function persistIdentity(path: string, identity: AgentIdentity): void {
  mkdirSync(dirname(path), { recursive: true });
  const stored: StoredIdentity = {
    agentId: identity.agentId,
    kid: identity.kid,
    privateKey: base64UrlEncode(identity.privateKey),
    publicKey: base64UrlEncode(identity.publicKey),
  };
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
}
