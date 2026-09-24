import { createPublicKey, createVerify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import type { Signature } from "../types.js";
import { base64UrlDecode } from "./ed25519.js";
import { sigInput } from "./sigInput.js";

export interface VerifyingKey {
  alg: "Ed25519" | "ECDSA_P256_SHA256";
  kid: string;
  /** Ed25519: raw 32 bytes. ECDSA_P256_SHA256: SPKI DER bytes. */
  publicKey: Uint8Array;
}

/**
 * `verify(key, purpose, digest, sig)` from SPEC §7.6: checks `sig.sig` over
 * `sigInput(purpose, digest)` using `key.alg`. Returns false (never throws) on any
 * malformed input, so `verifyBundle`'s pass can just record a failed check and continue.
 */
export function verifySignature(
  key: VerifyingKey | undefined,
  purpose: string,
  digest: Uint8Array,
  signature: Signature,
): boolean {
  if (!key || signature.alg !== key.alg || signature.kid !== key.kid) return false;
  try {
    const message = sigInput(purpose, digest);
    const sigBytes = base64UrlDecode(signature.sig);
    if (key.alg === "Ed25519") {
      return ed25519.verify(sigBytes, message, key.publicKey);
    }
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey), format: "der", type: "spki" });
    return createVerify("sha256").update(message).verify(publicKey, sigBytes);
  } catch {
    return false;
  }
}
