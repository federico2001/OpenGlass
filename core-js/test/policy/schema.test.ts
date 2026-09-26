import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

/** Confirms spec/openglass-policy/v1/schema.json actually accepts the shipped
 * default.yaml and rejects the same malformed shapes the Zod layer (types.ts) rejects —
 * so the JSON Schema, the artifact other languages/tools rely on, doesn't silently drift
 * from what this reference evaluator actually enforces. */
const SPEC_DIR = fileURLToPath(new URL("../../../spec/openglass-policy/v1/", import.meta.url));
const schema = JSON.parse(readFileSync(`${SPEC_DIR}schema.json`, "utf8"));
const ajv = new Ajv2020({ strict: true });
const validate = ajv.compile(schema);

describe("openglass-policy v1 JSON Schema", () => {
  it("accepts the shipped default.yaml", () => {
    const doc = parseYaml(readFileSync(`${SPEC_DIR}default.yaml`, "utf8"));
    const ok = validate(doc);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    expect(validate({ apiVersion: "openglass-policy/v1", kind: "Policy", metadata: { name: "x" }, rules: [], extra: true })).toBe(false);
  });

  it("rejects a bad apiVersion", () => {
    expect(validate({ apiVersion: "openglass-policy/v2", kind: "Policy", metadata: { name: "x" }, rules: [] })).toBe(false);
  });

  it("rejects a rule with an invalid risk level", () => {
    const doc = {
      apiVersion: "openglass-policy/v1",
      kind: "Policy",
      metadata: { name: "x" },
      rules: [{ id: "r1", risk: "critical", when: { field: "field:a", op: "exists" } }],
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a leaf condition missing op", () => {
    const doc = {
      apiVersion: "openglass-policy/v1",
      kind: "Policy",
      metadata: { name: "x" },
      rules: [{ id: "r1", risk: "high", when: { field: "field:a" } }],
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a field reference without an attr:/field: prefix", () => {
    const doc = {
      apiVersion: "openglass-policy/v1",
      kind: "Policy",
      metadata: { name: "x" },
      rules: [{ id: "r1", risk: "high", when: { field: "amountUsd", op: "gte", value: 1 } }],
    };
    expect(validate(doc)).toBe(false);
  });

  it("rejects a combinator mixed with a leaf field on the same node", () => {
    const doc = {
      apiVersion: "openglass-policy/v1",
      kind: "Policy",
      metadata: { name: "x" },
      rules: [{ id: "r1", risk: "high", when: { all: [{ field: "field:a", op: "exists" }], field: "field:b", op: "exists" } }],
    };
    expect(validate(doc)).toBe(false);
  });

  it("accepts a minimal valid policy with no rules", () => {
    expect(validate({ apiVersion: "openglass-policy/v1", kind: "Policy", metadata: { name: "empty" }, rules: [] })).toBe(true);
  });
});
