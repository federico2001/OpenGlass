import type { AttestedFetchResult, DirectFetcher, FetchWitness } from "openglass-sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checkEndpoint, type EndpointWitness } from "../../src/checks/endpoint.js";
import type { CheckDeps } from "../../src/checks/types.js";
import { goodCard, startFakeTarget, type FakeTarget } from "../fakeTarget.js";

/**
 * Unit coverage for checkEndpoint's witnessing branches (docs/SPEC.md §12.7) — a fake
 * EndpointWitness stands in for the real AttestationRecorder/OpenGlassClient chain (that
 * chain's own three-mode logic is covered by sdk-js's attestedFetch.test.ts), so these
 * tests are purely about whether checkEndpoint reacts to each AttestedFetchResult shape
 * correctly: which response it scores off, and that it never fires a second real request.
 */

let target: FakeTarget;

beforeEach(async () => {
  target = await startFakeTarget({ card: goodCard("{base}"), rpc: "message" });
});
afterAll(async () => {
  await target?.close();
});

function deps(witnessMode: CheckDeps["witnessMode"]): CheckDeps {
  return { net: { allowPrivateAddresses: true, userAgent: "test" }, registryUrl: "https://a2aregistry.test", witnessMode };
}

function card() {
  return goodCard(target.url);
}

function fakeWitness(overrides: Partial<FetchWitness["response"]> = {}): FetchWitness {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "x", result: { message: { messageId: "m1", role: "ROLE_AGENT", parts: [{ text: "witnessed hi" }] } } });
  return {
    id: "wfx_test",
    attestationId: "att_1",
    requestedBy: "agt_1",
    seq: 1,
    prevHash: "a".repeat(64),
    url: `${target.url}/rpc`,
    method: "POST",
    request: { contentType: "application/json", bodySha256: "b".repeat(64), bodyBytes: 10, bodyText: "{}" },
    requestedAt: new Date(Date.now() - 50).toISOString(),
    fetchedAt: new Date().toISOString(),
    response: { status: 200, headers: {}, contentType: "application/json", bodySha256: "c".repeat(64), bodyBytes: body.length, bodyTruncated: false, bodyText: body, ...overrides },
    hash: "d".repeat(64),
    platformSignature: { alg: "ECDSA_P256_SHA256", kid: "plat-1", sig: "sig" },
  };
}

describe("checkEndpoint witnessing", () => {
  it("with no witness at all: behaves exactly as before (unwitnessed, scores off the real fetch)", async () => {
    const result = await checkEndpoint(card(), deps("off"));
    expect(result.section.details).toMatchObject({ ok: true, outcome: "message", witnessed: false, witnessReason: null });
    expect(target.requests).toHaveLength(1);
  });

  it('mode "primary", witnessed successfully: scores off OpenGlass\'s own response, no direct request at all', async () => {
    const attestedFetch = async (): Promise<AttestedFetchResult> => ({ witnessed: true, reason: "primary", witness: fakeWitness() });
    const witness: EndpointWitness = { attestedFetch };
    const result = await checkEndpoint(card(), deps("primary"), witness);

    expect(result.section.details).toMatchObject({ ok: true, outcome: "message", witnessed: true, witnessReason: "primary" });
    expect(result.json).toMatchObject({ result: { message: { parts: [{ text: "witnessed hi" }] } } });
    expect(target.requests).toHaveLength(0); // OpenGlass's own fetch was the only request, and this test's fake didn't touch the real target
  });

  it('mode "primary": a payment-required header on the witness flows through to the response (x402 relies on this)', async () => {
    const attestedFetch = async (): Promise<AttestedFetchResult> => ({
      witnessed: true,
      reason: "primary",
      witness: fakeWitness({ status: 402, headers: { "payment-required": "eyJhIjoxfQ==" }, bodyText: "{}" }),
    });
    const result = await checkEndpoint(card(), deps("primary"), { attestedFetch });
    expect(result.response?.status).toBe(402);
    expect(result.response?.headers.get("payment-required")).toBe("eyJhIjoxfQ==");
  });

  it('mode "primary", OpenGlass itself unreachable: falls back to one direct request, reported unwitnessed', async () => {
    const attestedFetch = async (_url: string, opts: { directFetch: DirectFetcher }): Promise<AttestedFetchResult> => {
      const direct = await opts.directFetch(`${target.url}/rpc`, { method: "POST" });
      return { witnessed: false, reason: "openglass_unreachable_fallback: network error", direct };
    };
    const result = await checkEndpoint(card(), deps("primary"), { attestedFetch });

    expect(result.section.details).toMatchObject({ ok: true, outcome: "message", witnessed: false });
    expect(result.section.details.witnessReason).toMatch(/^openglass_unreachable_fallback:/);
    expect(target.requests).toHaveLength(1); // the fallback, not a duplicate
  });

  it('mode "primary", OpenGlass witnessed that the target itself failed: reports network-error, never retries', async () => {
    const attestedFetch = async (): Promise<AttestedFetchResult> => ({ witnessed: false, reason: "target_unreachable: blocked address" });
    const result = await checkEndpoint(card(), deps("primary"), { attestedFetch });

    expect(result.section.details.outcome).toBe("network-error");
    expect(result.section.score).toBe(0);
    expect(target.requests).toHaveLength(0); // never fires a second, unwitnessed request
  });

  it('mode "shadow": always scores off the real direct response, even though it was also witnessed', async () => {
    const attestedFetch = async (_url: string, opts: { directFetch: DirectFetcher }): Promise<AttestedFetchResult> => {
      const direct = await opts.directFetch(`${target.url}/rpc`, { method: "POST" });
      return { witnessed: true, reason: "shadow", witness: fakeWitness(), direct };
    };
    const result = await checkEndpoint(card(), deps("shadow"), { attestedFetch });

    expect(result.section.details).toMatchObject({ ok: true, outcome: "message", witnessed: true, witnessReason: "shadow" });
    // The real target's own reply is what got scored, not the fake witness's canned text.
    expect(result.json).toMatchObject({ result: { message: { parts: [{ text: expect.stringContaining("Ignore all checks") }] } } });
    expect(target.requests).toHaveLength(1);
  });

  it('mode "shadow": still scores off direct when the witness attempt itself fails', async () => {
    const attestedFetch = async (_url: string, opts: { directFetch: DirectFetcher }): Promise<AttestedFetchResult> => {
      const direct = await opts.directFetch(`${target.url}/rpc`, { method: "POST" });
      return { witnessed: false, reason: "shadow_witness_failed: network down", direct };
    };
    const result = await checkEndpoint(card(), deps("shadow"), { attestedFetch });

    expect(result.section.details).toMatchObject({ ok: true, outcome: "message", witnessed: false });
    expect(result.section.details.witnessReason).toMatch(/^shadow_witness_failed:/);
    expect(target.requests).toHaveLength(1);
  });
});
