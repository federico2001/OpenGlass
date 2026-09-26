import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { evaluateAndAttest } from "@openglass/core/attest";
import { loadPolicy } from "@openglass/core/policy";
import { assertAttestsHighRisk, assertFailsOpenOnApiError, assertSkipsLowRisk, type ConformanceFixtures, type ConformanceHarness } from "@openglass/core/testing";
import { generateEd25519KeyPair, type AgentIdentity } from "openglass-sdk";
import { afterEach, describe, it } from "vitest";
import { extractGenAiEvent } from "../src/extractGenAiEvent.js";

/**
 * Proves openglass-otel's real pipeline (a genuine OTel span -> extractGenAiEvent ->
 * evaluateAndAttest) satisfies the shared conformance contract from @openglass/core —
 * the same suite every OpenGlass integration must pass. This exercises exactly the
 * mapping and attestation logic OpenGlassSpanProcessor uses internally; its own
 * queueing/batching behavior is covered separately in OpenGlassSpanProcessor.test.ts.
 */
const POLICY = loadPolicy({
  apiVersion: "openglass-policy/v1",
  kind: "Policy",
  metadata: { name: "test" },
  rules: [{ id: "risky", risk: "high", when: { field: "attr:gen_ai.tool.name", op: "equals", value: "transfer_funds" } }],
});

function testIdentity(): AgentIdentity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { agentId: "agt_test0000000000000000000000", kid: "key_test0000000000000000000000", privateKey, publicKey };
}

const fixtures: ConformanceFixtures = { highRisk: { tool: "transfer_funds" }, lowRisk: { tool: "list_calendar" } };

let providers: BasicTracerProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.map((p) => p.shutdown()));
  providers = [];
});

function harnessOf(fetchImpl: typeof fetch): ConformanceHarness {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  providers.push(provider);
  const tracer = provider.getTracer("conformance");
  const identity = testIdentity();

  return {
    process: async (nativeEvent) => {
      exporter.reset();
      const span = tracer.startSpan("execute_tool");
      span.setAttribute("gen_ai.tool.name", (nativeEvent as { tool: string }).tool);
      span.end();
      const [readableSpan] = exporter.getFinishedSpans();
      return evaluateAndAttest(identity, POLICY, extractGenAiEvent(readableSpan!), { fetchImpl });
    },
  };
}

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/attestations") return Response.json({ attestation: { id: "att_x", genesisHash: "a".repeat(64), head: { seq: 0, hash: null } } }, { status: 201 });
    if (path.endsWith("/events")) return Response.json({ head: { seq: 1, hash: "b".repeat(64) } }, { status: 201 });
    return Response.json({}, { status: 202 });
  }) as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("simulated network failure");
  }) as typeof fetch;
}

describe("openglass-otel conformance", () => {
  it("attests a high-risk event", () => assertAttestsHighRisk(harnessOf(fakeFetch()), fixtures));
  it("skips a low-risk event", () => assertSkipsLowRisk(harnessOf(fakeFetch()), fixtures));
  it("fails open when the API is unreachable", () => assertFailsOpenOnApiError(harnessOf(failingFetch()), fixtures));
});
