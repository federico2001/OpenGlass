import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/crypto/canonicalJson.js";

/**
 * RFC 8785 (JCS) conformance — ported from `packages/db/test/crypto/jcs.vectors.test.ts`.
 * See that file's comments for why each vector is shaped the way it is. This port must
 * keep passing the same cases the server's implementation does, or agent signatures made
 * with this SDK won't verify against a real OpenGlass server.
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
    expect(canonicalize({ n: big })).toBe(`{"n":${big.toString()}}`);
    expect(canonicalize({ n: small })).toBe(`{"n":${small.toString()}}`);
  });

  it("escapes strings exactly like JSON.stringify (control chars, short escapes, literal '/')", () => {
    const tricky = `/${String.fromCharCode(0x20ac)}$${String.fromCharCode(0x0f)}\nA'B"\\`;
    const escaped = JSON.stringify(tricky);
    expect(canonicalize({ s: tricky })).toBe(`{"s":${escaped}}`);
  });

  it("produces no insignificant whitespace", () => {
    expect(canonicalize({ a: 1, b: [1, 2, { c: 3 }] })).toBe('{"a":1,"b":[1,2,{"c":3}]}');
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
