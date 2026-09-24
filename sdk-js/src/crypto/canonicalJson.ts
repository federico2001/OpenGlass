/**
 * RFC 8785 JSON Canonicalization Scheme (JCS). Ported byte-for-byte from
 * `packages/db/src/crypto/canonicalJson.ts` — the two MUST stay identical, or agent
 * signatures made with this SDK will fail to verify against the server. `test/crypto/`
 * checks this port against both the RFC's own vectors and live fixtures generated from
 * the server's implementation (see `fixtures/vectors.json`).
 *
 * - Object keys are sorted by UTF-16 code unit order (JS's default string `<` comparison).
 * - No insignificant whitespace anywhere in the output.
 * - Numbers follow ECMAScript Number::toString, which is exactly what JS's own
 *   number-to-string conversion already produces (including `-0` -> `"0"`).
 * - Strings use standard JSON escaping; JSON.stringify already matches JCS here.
 */

export function canonicalize(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true || value === false) return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`JCS: non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(",")}}`;
  }
  throw new Error(`JCS: unsupported value of type ${typeof value}`);
}

/** JCS(x) as UTF-8 bytes, ready for hashing. */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
