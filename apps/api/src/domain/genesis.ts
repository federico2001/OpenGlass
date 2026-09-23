import { canonicalizeToBytes, hex, sha256, type Accept, type Offer, type Signature } from "@openglass/db";

/** SPEC §7.2: `genesisHash = hex(H(JCS({ offer, offerSignature, accept, acceptSignature })))`. */
export function computeGenesisHash(offer: Offer, offerSignature: Signature, accept: Accept, acceptSignature: Signature) {
  const bytes = sha256(canonicalizeToBytes({ offer, offerSignature, accept, acceptSignature }));
  return { genesisHashBytes: bytes, genesisHash: hex(bytes) };
}

const CLOCK_SKEW_MS = 300_000;

export function withinClockSkew(iso: string, now = Date.now()): boolean {
  const skew = Math.abs(now - Date.parse(iso));
  return Number.isFinite(skew) && skew <= CLOCK_SKEW_MS;
}
