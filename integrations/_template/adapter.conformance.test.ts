/**
 * Skeleton conformance test for a new integration (TypeScript). Copy alongside your own
 * adapter.ts, point `fixtures` at native events your own mapping actually classifies as
 * high/low risk under the policy you test with, and run these three checks — the
 * contract every OpenGlass integration must satisfy. See ../../otel-js/test/conformance.test.ts
 * for a complete, real example. (Uses vitest below; swap for your own test runner's
 * equivalent of describe/it if you're not using it.)
 */
import { describe, it } from "vitest";
import { assertAttestsHighRisk, assertFailsOpenOnApiError, assertSkipsLowRisk, type ConformanceFixtures, type ConformanceHarness } from "@openglass/core/testing";
import { loadPolicy } from "@openglass/core/policy";
import { generateEd25519KeyPair, type AgentIdentity } from "openglass-sdk";
import { handleNativeEvent, type NativeEvent } from "./adapter.js";

const POLICY = loadPolicy({
  apiVersion: "openglass-policy/v1",
  kind: "Policy",
  metadata: { name: "test" },
  // TODO: a minimal policy matching a real high-risk native event for your framework.
  rules: [{ id: "risky", risk: "high", when: { field: "attr:gen_ai.tool.name", op: "equals", value: "transfer_funds" } }],
});

function testIdentity(): AgentIdentity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { agentId: "agt_test0000000000000000000000", kid: "key_test0000000000000000000000", privateKey, publicKey };
}

// TODO: a fetch double is enough for this — no real OpenGlass server needed. See
// otel-js's or @openglass/core's own tests for the full open/event/close fake-server shape.
function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/attestations") return Response.json({ attestation: { id: "att_x", genesisHash: "a".repeat(64), head: { seq: 0, hash: null } } }, { status: 201 });
    if (path.endsWith("/events")) return Response.json({ head: { seq: 1, hash: "b".repeat(64) } }, { status: 201 });
    return Response.json({}, { status: 202 });
  }) as typeof fetch;
}

function harness(fetchImpl: typeof fetch): ConformanceHarness {
  const identity = testIdentity();
  return { process: (nativeEvent) => handleNativeEvent(nativeEvent as NativeEvent, { identity, policy: POLICY, fetchImpl }) };
}

const fixtures: ConformanceFixtures = {
  highRisk: { toolName: "transfer_funds" } satisfies NativeEvent,
  lowRisk: { toolName: "list_calendar" } satisfies NativeEvent,
};

describe("conformance", () => {
  it("attests a high-risk event", () => assertAttestsHighRisk(harness(fakeFetch()), fixtures));
  it("skips a low-risk event", () => assertSkipsLowRisk(harness(fakeFetch()), fixtures));
  it("fails open when the API is unreachable", () =>
    assertFailsOpenOnApiError(
      harness(async () => {
        throw new Error("simulated network failure");
      }),
      fixtures,
    ));
});
