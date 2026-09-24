import { ed25519 } from "@noble/curves/ed25519";

/** Agent identity keys. Raw 32-byte keys/64-byte signatures, matching OpenGlass's wire
 * encoding (`publicKey` = 43-char base64url = 32 raw bytes, no padding). */

export function generateEd25519KeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function signEd25519(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
