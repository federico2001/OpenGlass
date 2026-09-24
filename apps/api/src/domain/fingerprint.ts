import { base64UrlDecode, hex, sha256 } from "@openglass/db";

/** SPEC §5.1: "the first 16 hex chars of sha256(publicKey), in groups of 4." The owner
 * checks this against what the agent prints, to confirm they're claiming the right key. */
export function keyFingerprint(publicKeyBase64Url: string): string {
  const digest = hex(sha256(base64UrlDecode(publicKeyBase64Url))).slice(0, 16);
  return digest.match(/.{1,4}/g)!.join(" ");
}
