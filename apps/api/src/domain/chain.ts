import { canonicalizeToBytes, hex, hexToBytes, sha256, type MessageEnvelope } from "@openglass/db";

/** SPEC §7.3: `hash = hex(H(bytes(prevHash) || utf8(JCS(envelope))))`. */
export function computeMessageHash(prevHash: string, envelope: MessageEnvelope): { hashBytes: Buffer; hash: string } {
  const hashBytes = sha256(Buffer.concat([hexToBytes(prevHash), canonicalizeToBytes(envelope)]));
  return { hashBytes, hash: hex(hashBytes) };
}

/** SPEC §7.3: the digest the platform countersigns over. */
export function computeCountersignDigest(hash: string, agentSig: string, receivedAt: string): Buffer {
  return sha256(canonicalizeToBytes({ hash, agentSig, receivedAt }));
}
