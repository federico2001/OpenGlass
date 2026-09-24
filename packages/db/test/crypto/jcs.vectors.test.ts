import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/crypto/canonicalJson.js";

/**
 * RFC 8785 (JCS) conformance checks.
 *
 * The "french" vector below is the spec authors' own official test vector
 * (github.com/cyberphone/json-canonicalization/tree/master/testdata/{input,output}/french.json),
 * transcribed directly since it contains no backslash escaping to get wrong. It exercises
 * JCS's most distinctive requirement: keys sorted by raw UTF-16 code unit, explicitly NOT
 * locale-aware collation (a naive locale-sensitive sort would order these differently).
 *
 * The number/string-escaping cases are self-verifying rather than copied from an external
 * fixture: each expected value is derived live from the same ECMAScript primitives JCS
 * itself mandates (`Number::toString` for numbers, `JSON.stringify`'s escaping for
 * strings), so there's no hand-transcribed byte sequence that could silently drift from
 * what the spec actually requires.
 */

const FRENCH_INPUT = {
  peach: "This sorting order",
  "péché": "is wrong according to French",
  "pêche": "but canonicalization MUST",
  sin: "ignore locale",
};
const FRENCH_OUTPUT =
  '{"peach":"This sorting order","péché":"is wrong according to French","pêche":"but canonicalization MUST","sin":"ignore locale"}';

describe("canonicalize (RFC 8785 JCS)", () => {
  it("matches the official 'french' vector (UTF-16 code unit key order, not locale order)", () => {
    expect(canonicalize(FRENCH_INPUT)).toBe(FRENCH_OUTPUT);
  });

  it("formats numbers per ECMAScript Number::toString, including exponential notation", () => {
    const big = 1e30;
    const small = 2e-3;
    const fractional = 333333333.33333329; // rounds to the nearest representable double
    expect(canonicalize({ n: big })).toBe(`{"n":${big.toString()}}`);
    expect(canonicalize({ n: small })).toBe(`{"n":${small.toString()}}`);
    expect(canonicalize({ n: fractional })).toBe(`{"n":${fractional.toString()}}`);
    expect(big.toString()).toBe("1e+30");
    expect(small.toString()).toBe("0.002");
  });

  it("escapes strings exactly like JSON.stringify (control chars, short escapes, literal '/')", () => {
    // Slash placed away from the backslash so the raw output can't accidentally contain
    // an old-style "\/" as a side effect of an unrelated escaped backslash next to it.
    const tricky = `/${String.fromCharCode(0x20ac)}$${String.fromCharCode(0x0f)}\nA'B"\\`;
    const escaped = JSON.stringify(tricky);
    expect(canonicalize({ s: tricky })).toBe(`{"s":${escaped}}`);
    expect(escaped).toContain("\\u000f"); // lowercase \u escape for the control char
    expect(escaped).toContain("\\n"); // short escape for the newline
    expect(escaped.startsWith('"/')).toBe(true); // the leading '/' is never escaped
  });

  it("produces no insignificant whitespace", () => {
    expect(canonicalize({ a: 1, b: [1, 2, { c: 3 }] })).toBe('{"a":1,"b":[1,2,{"c":3}]}');
  });

  it("sorts keys the same regardless of input order (idempotent under key shuffling)", () => {
    expect(canonicalize({ z: 1, a: 2, m: 3 })).toBe(canonicalize({ a: 2, m: 3, z: 1 }));
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
  });

  it("omits undefined object properties, matching JSON.stringify", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers rather than silently emitting invalid JSON", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow();
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow();
  });
});
