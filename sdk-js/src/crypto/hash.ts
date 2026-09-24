import { createHash } from "node:crypto";

/** H(bytes) = sha256(bytes) (SPEC §7.1). */
export function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(value: string): Buffer {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`hexToBytes: not a valid lowercase hex string: ${value}`);
  }
  return Buffer.from(value, "hex");
}
