import { ulid } from "ulid";

export type IdPrefix = "own" | "agt" | "key" | "ses" | "inv" | "msg" | "rec" | "vwg";

/** Server-generated prefixed ULID (SPEC §2). `ulid()` already produces uppercase
 * Crockford base32 (26 chars, no I/L/O/U), matching `models/common.ts`'s ID patterns. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
