import { generateEd25519KeyPair, type AgentIdentity } from "openglass-sdk";
import { describe, expect, it } from "vitest";
import { evaluateAndAttest } from "../../src/attest/attest.js";
import { loadPolicy } from "../../src/policy/loadPolicy.js";
import { assertAttestsHighRisk, assertFailsOpenOnApiError, assertSkipsLowRisk, runAllConformanceChecks, type ConformanceHarness } from "../../src/testing/conformance.js";

/**
 * Proves the conformance suite itself is correct, using `evaluateAndAttest` — the
 * primitive every real integration calls — as the harness under test. A real
 * integration's own test file follows this exact shape: build a `ConformanceHarness`
 * around your framework-native-event -> PolicyEvent mapping, then call these same
 * assertions.
 */
const POLICY = loadPolicy({
  apiVersion: "openglass-policy/v1",
  kind: "Policy",
  metadata: { name: "test" },
  rules: [{ id: "risky", risk: "high", when: { field: "field:tool", op: "equals", value: "transfer_funds" } }],
});

function testIdentity(): AgentIdentity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { agentId: "agt_test0000000000000000000000", kid: "key_test0000000000000000000000", privateKey, publicKey };
}

function successHarness(): ConformanceHarness {
  const identity = testIdentity();
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/attestations") return Response.json({ attestation: { id: "att_x", genesisHash: "a".repeat(64), head: { seq: 0, hash: null } } }, { status: 201 });
    if (path.endsWith("/events")) return Response.json({ head: { seq: 1, hash: "b".repeat(64) } }, { status: 201 });
    return Response.json({}, { status: 202 });
  };
  return { process: (nativeEvent) => evaluateAndAttest(identity, POLICY, nativeEvent as { fields: { tool: string } }, { fetchImpl }) };
}

function failingHarness(): ConformanceHarness {
  const identity = testIdentity();
  const fetchImpl: typeof fetch = async () => {
    throw new Error("simulated network failure");
  };
  return { process: (nativeEvent) => evaluateAndAttest(identity, POLICY, nativeEvent as { fields: { tool: string } }, { fetchImpl, retries: 1, onError: () => {} }) };
}

const fixtures = { highRisk: { fields: { tool: "transfer_funds" } }, lowRisk: { fields: { tool: "list_calendar" } } };

describe("conformance suite", () => {
  it("assertAttestsHighRisk passes against a working harness", () => assertAttestsHighRisk(successHarness(), fixtures));
  it("assertSkipsLowRisk passes against a working harness", () => assertSkipsLowRisk(successHarness(), fixtures));
  it("runAllConformanceChecks passes against a working harness", () => runAllConformanceChecks(successHarness(), fixtures));
  it("assertFailsOpenOnApiError passes against a harness wired to a failing transport", () => assertFailsOpenOnApiError(failingHarness(), fixtures));

  it("assertAttestsHighRisk fails loudly against a harness that never attests", async () => {
    const brokenHarness: ConformanceHarness = { process: async () => ({ attested: false, reason: "below_threshold", risk: "low", matches: [] }) };
    await expect(assertAttestsHighRisk(brokenHarness, fixtures)).rejects.toThrow(/expected an attestation/);
  });

  it("assertSkipsLowRisk fails loudly against a harness that over-attests", async () => {
    const overAttests: ConformanceHarness = { process: async () => ({ attested: true, attestationId: "att_x", risk: "high", matches: [] }) };
    await expect(assertSkipsLowRisk(overAttests, fixtures)).rejects.toThrow(/expected no attestation/);
  });
});
