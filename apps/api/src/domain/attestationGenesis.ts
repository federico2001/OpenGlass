import { canonicalizeToBytes, hex, sha256, type AttestationOpen, type Signature } from "@openglass/db";

/** Prompt 20 / SPEC §12: `genesisHash = hex(H(JCS({ open, openSignature })))` — the
 * one-party counterpart to `computeGenesisHash` in genesis.ts. */
export function computeAttestationGenesisHash(open: AttestationOpen, openSignature: Signature) {
  const bytes = sha256(canonicalizeToBytes({ open, openSignature }));
  return { genesisHashBytes: bytes, genesisHash: hex(bytes) };
}
