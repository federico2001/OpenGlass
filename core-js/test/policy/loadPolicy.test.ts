import { describe, expect, it } from "vitest";
import { loadPolicy } from "../../src/policy/index.js";

describe("loadPolicy", () => {
  it("parses a YAML string", () => {
    const policy = loadPolicy(`
apiVersion: openglass-policy/v1
kind: Policy
metadata: { name: test }
rules:
  - id: r1
    risk: high
    when: { field: "field:action", op: equals, value: delete_user }
`);
    expect(policy.metadata.name).toBe("test");
    expect(policy.rules).toHaveLength(1);
  });

  it("accepts a plain object without parsing", () => {
    const policy = loadPolicy({
      apiVersion: "openglass-policy/v1",
      kind: "Policy",
      metadata: { name: "test" },
      rules: [],
    });
    expect(policy.rules).toHaveLength(0);
  });

  it("rejects duplicate rule ids", () => {
    expect(() =>
      loadPolicy({
        apiVersion: "openglass-policy/v1",
        kind: "Policy",
        metadata: { name: "test" },
        rules: [
          { id: "dup", risk: "high", when: { field: "field:a", op: "exists" } },
          { id: "dup", risk: "low", when: { field: "field:b", op: "exists" } },
        ],
      }),
    ).toThrow(/duplicate rule id/);
  });

  it("rejects a field reference without an attr:/field: prefix", () => {
    expect(() =>
      loadPolicy({
        apiVersion: "openglass-policy/v1",
        kind: "Policy",
        metadata: { name: "test" },
        rules: [{ id: "r1", risk: "high", when: { field: "amountUsd", op: "gte", value: 1 } }],
      }),
    ).toThrow();
  });

  it("rejects an unknown top-level field", () => {
    expect(() =>
      loadPolicy({
        apiVersion: "openglass-policy/v1",
        kind: "Policy",
        metadata: { name: "test" },
        rules: [],
        extra: true,
      }),
    ).toThrow();
  });
});
