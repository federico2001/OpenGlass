import { createHash, randomBytes } from "node:crypto";

/** Opaque bearer tokens (claim tokens, login tokens, web session tokens, open-invite
 * tokens): random bytes, base64url-encoded. Only the sha256 hash is ever stored. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
