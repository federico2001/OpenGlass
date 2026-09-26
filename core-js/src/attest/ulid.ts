import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I/L/O/U, matches packages/db's ULID regex

/** A 26-char ULID-shaped random id (time-sortability isn't needed here — the server
 * assigns real ordering — so this is just Crockford base32 random bytes, the same
 * approach skill.md's own reference code uses for `sessionId`). */
export function randomUlid(): string {
  return Array.from(randomBytes(26), (b) => CROCKFORD_BASE32[b % 32]).join("");
}
