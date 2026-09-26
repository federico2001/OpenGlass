import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";
import { loadPolicy } from "@openglass/core/policy";
import { generateEd25519KeyPair, type AgentIdentity } from "openglass-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenGlassSpanProcessor } from "../src/OpenGlassSpanProcessor.js";

const POLICY = loadPolicy({
  apiVersion: "openglass-policy/v1",
  kind: "Policy",
  metadata: { name: "test" },
  rules: [{ id: "risky-tool", risk: "high", when: { field: "attr:gen_ai.tool.name", op: "equals", value: "transfer_funds" } }],
});

function testIdentity(): AgentIdentity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { agentId: "agt_test0000000000000000000000", kid: "key_test0000000000000000000000", privateKey, publicKey };
}

function fakeFetch(calls: { path: string }[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path });
    if (path === "/v1/attestations") return Response.json({ attestation: { id: "att_x", genesisHash: "a".repeat(64), head: { seq: 0, hash: null } } }, { status: 201 });
    if (path.endsWith("/events")) return Response.json({ head: { seq: 1, hash: "b".repeat(64) } }, { status: 201 });
    return Response.json({}, { status: 202 });
  }) as typeof fetch;
}

let provider: BasicTracerProvider | undefined;
afterEach(async () => {
  await provider?.shutdown();
  provider = undefined;
});

describe("OpenGlassSpanProcessor", () => {
  it("attests a high-risk GenAI span once flushed", async () => {
    const calls: { path: string }[] = [];
    const processor = new OpenGlassSpanProcessor({ identity: testIdentity(), policy: POLICY, fetchImpl: fakeFetch(calls) });
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");

    const span = tracer.startSpan("execute_tool");
    span.setAttribute("gen_ai.operation.name", "execute_tool");
    span.setAttribute("gen_ai.tool.name", "transfer_funds");
    span.end();

    await processor.forceFlush();

    expect(calls.map((c) => c.path)).toEqual(["/v1/attestations", expect.stringContaining("/events"), expect.stringContaining("/close")]);
  });

  it("does not attest a benign GenAI span", async () => {
    const calls: { path: string }[] = [];
    const processor = new OpenGlassSpanProcessor({ identity: testIdentity(), policy: POLICY, fetchImpl: fakeFetch(calls) });
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");

    const span = tracer.startSpan("execute_tool");
    span.setAttribute("gen_ai.tool.name", "list_calendar");
    span.end();

    await processor.forceFlush();
    expect(calls).toHaveLength(0);
  });

  it("synthesizes error.type from span status when the instrumentation didn't set one", async () => {
    const calls: { path: string }[] = [];
    const errorPolicy = loadPolicy({
      apiVersion: "openglass-policy/v1",
      kind: "Policy",
      metadata: { name: "test" },
      rules: [{ id: "errored", risk: "high", when: { field: "attr:error.type", op: "exists" } }],
    });
    const processor = new OpenGlassSpanProcessor({ identity: testIdentity(), policy: errorPolicy, fetchImpl: fakeFetch(calls) });
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");

    const span = tracer.startSpan("execute_tool");
    span.setStatus({ code: SpanStatusCode.ERROR, message: "boom" });
    span.end();

    await processor.forceFlush();
    expect(calls.map((c) => c.path)).toContain("/v1/attestations");
  });

  it("batches multiple ended spans into one flush", async () => {
    const calls: { path: string }[] = [];
    const processor = new OpenGlassSpanProcessor({ identity: testIdentity(), policy: POLICY, fetchImpl: fakeFetch(calls) });
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");

    for (let i = 0; i < 3; i++) {
      const span = tracer.startSpan(`tool-${i}`);
      span.setAttribute("gen_ai.tool.name", "transfer_funds");
      span.end();
    }
    await processor.forceFlush();

    const opens = calls.filter((c) => c.path === "/v1/attestations");
    expect(opens).toHaveLength(3);
  });

  it("flushes automatically on its scheduled interval", async () => {
    vi.useFakeTimers();
    try {
      const calls: { path: string }[] = [];
      const processor = new OpenGlassSpanProcessor({ identity: testIdentity(), policy: POLICY, fetchImpl: fakeFetch(calls), scheduledDelayMs: 1000 });
      provider = new BasicTracerProvider({ spanProcessors: [processor] });
      const tracer = provider.getTracer("test");
      const span = tracer.startSpan("execute_tool");
      span.setAttribute("gen_ai.tool.name", "transfer_funds");
      span.end();

      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.map((c) => c.path)).toContain("/v1/attestations");
    } finally {
      vi.useRealTimers();
    }
  });
});
