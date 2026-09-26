import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { evaluate, loadPolicy, type Policy } from "../../src/policy/index.js";

/** Shared with core-py's test suite — a discrepancy here means the two reference
 * evaluators (or the shipped default.yaml policy) have drifted apart. */
const SPEC_DIR = fileURLToPath(new URL("../../../spec/openglass-policy/v1/", import.meta.url));
const defaultPolicy: Policy = loadPolicy(readFileSync(`${SPEC_DIR}default.yaml`, "utf8"));
const vectors = parseYaml(readFileSync(`${SPEC_DIR}test-vectors.yaml`, "utf8")) as {
  cases: {
    name: string;
    policy: "default" | Record<string, unknown>;
    event: { attributes?: Record<string, unknown>; fields?: Record<string, unknown> };
    expect: { risk: string; matchedIds: string[]; defaultApplied: boolean; reasons?: string[] };
  }[];
};

describe("openglass-policy v1 test vectors (spec/openglass-policy/v1/test-vectors.yaml)", () => {
  it.each(vectors.cases)("$name", (c) => {
    const policy = c.policy === "default" ? defaultPolicy : loadPolicy(c.policy);
    const result = evaluate(policy, c.event as never);
    expect(result.risk).toBe(c.expect.risk);
    expect(result.matches.map((m) => m.id)).toEqual(c.expect.matchedIds);
    expect(result.defaultApplied).toBe(c.expect.defaultApplied);
    if (c.expect.reasons) {
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.reasons).toEqual(c.expect.reasons);
    }
  });
});
