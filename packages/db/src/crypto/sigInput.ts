/**
 * Domain-separated signing input (SPEC §7.1):
 *   sigInput(purpose, digest) = utf8("openglass/v1/" + purpose) || 0x00 || digest
 * The purpose prefix keeps a signature made for one purpose (e.g. "offer") from being
 * replayed as another (e.g. "accept"). `digest` must be exactly 32 raw bytes.
 */
export function sigInput(purpose: string, digest: Uint8Array): Buffer {
  if (digest.length !== 32) {
    throw new Error(`sigInput: digest must be 32 bytes, got ${digest.length}`);
  }
  const prefix = Buffer.from(`openglass/v1/${purpose}`, "utf8");
  return Buffer.concat([prefix, Buffer.from([0x00]), Buffer.from(digest)]);
}
