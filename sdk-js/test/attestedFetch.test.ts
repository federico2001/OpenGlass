import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenGlassApiError, OpenGlassClient, type DirectFetchResult, type FetchWitness } from "../src/index.js";

/**
 * Pure unit coverage for the three-mode attestedFetch primitive (docs/SPEC.md §12.7):
 * mocks `client.witnessFetch` directly rather than standing up a live stack, since every
 * branch here is about attestedFetch's own decision logic (which request runs, when a
 * failure is the target's vs. OpenGlass's own, whether the result is ever silently
 * presented as witnessed when it wasn't) — none of it needs a real attestation or a real
 * network round trip to OpenGlass.
 */

function fakeIdentity() {
  return { kid: "k1", agentId: "agt_test", privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) };
}

function directResult(status = 200): DirectFetchResult {
  return { status, headers: new Headers(), body: Buffer.from("direct") };
}

function fakeWitness(): FetchWitness {
  return {
    id: "wfx_test",
    attestationId: "att_1",
    requestedBy: "agt_test",
    seq: 1,
    prevHash: "a".repeat(64),
    url: "https://target.example/",
    method: "GET",
    request: null,
    requestedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    response: { status: 200, headers: {}, contentType: "text/plain", bodySha256: "b".repeat(64), bodyBytes: 5, bodyTruncated: false, bodyText: "hello" },
    hash: "c".repeat(64),
    platformSignature: { alg: "ECDSA_P256_SHA256", kid: "plat-1", sig: "sig" },
  };
}

function apiError(status: number, code: string): OpenGlassApiError {
  return new OpenGlassApiError("POST", "/v1/attestations/att_1/witness-fetch", status, { error: { code } });
}

describe("OpenGlassClient.attestedFetch", () => {
  it('mode "off": runs directFetch only, never calls OpenGlass, and reports unwitnessed', async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    const witnessFetch = vi.spyOn(client, "witnessFetch");
    const direct = directResult();
    const directFetch = vi.fn().mockResolvedValue(direct);

    const result = await client.attestedFetch("att_1", "https://target.example", { mode: "off", directFetch });

    expect(result).toEqual({ witnessed: false, reason: "off", direct });
    expect(directFetch).toHaveBeenCalledWith("https://target.example", { method: "GET", body: undefined });
    expect(witnessFetch).not.toHaveBeenCalled();
  });

  it('mode "primary" (the default): OpenGlass\'s own fetch is the only request', async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    const witness = fakeWitness();
    vi.spyOn(client, "witnessFetch").mockResolvedValue(witness);
    const directFetch = vi.fn();

    const result = await client.attestedFetch("att_1", "https://target.example", { directFetch });

    expect(result).toEqual({ witnessed: true, reason: "primary", witness });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('mode "primary": falls back to directFetch, marked unwitnessed, only when OpenGlass itself is unreachable', async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    vi.spyOn(client, "witnessFetch").mockRejectedValue(apiError(503, "unavailable"));
    const direct = directResult();
    const directFetch = vi.fn().mockResolvedValue(direct);

    const result = await client.attestedFetch("att_1", "https://target.example", { directFetch });

    expect(result.witnessed).toBe(false);
    expect(result.reason).toMatch(/^openglass_unreachable_fallback:/);
    expect(result.direct).toBe(direct);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });

  it('mode "primary": never fires a second request when OpenGlass already witnessed that the target itself failed', async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    vi.spyOn(client, "witnessFetch").mockRejectedValue(apiError(422, "url_unreachable"));
    const directFetch = vi.fn();

    const result = await client.attestedFetch("att_1", "https://target.example", { directFetch });

    expect(result.witnessed).toBe(false);
    expect(result.reason).toMatch(/^target_unreachable:/);
    expect(result.direct).toBeUndefined();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('mode "shadow": directFetch is the real request, witnessed redundantly afterward', async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    const witness = fakeWitness();
    const witnessFetch = vi.spyOn(client, "witnessFetch").mockResolvedValue(witness);
    const direct = directResult();
    const directFetch = vi.fn().mockResolvedValue(direct);

    const result = await client.attestedFetch("att_1", "https://target.example", { mode: "shadow", directFetch });

    expect(result).toEqual({ witnessed: true, reason: "shadow", witness, direct });
    expect(directFetch).toHaveBeenCalledTimes(1);
    expect(witnessFetch).toHaveBeenCalledTimes(1);
  });

  it('mode "shadow": still returns the real direct result when the witness attempt itself fails', async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    vi.spyOn(client, "witnessFetch").mockRejectedValue(new Error("network down"));
    const direct = directResult();
    const directFetch = vi.fn().mockResolvedValue(direct);

    const result = await client.attestedFetch("att_1", "https://target.example", { mode: "shadow", directFetch });

    expect(result.witnessed).toBe(false);
    expect(result.reason).toMatch(/^shadow_witness_failed:/);
    expect(result.direct).toBe(direct);
  });

  it("attestationId: null forces off, regardless of opts.mode, and still runs directFetch", async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    const witnessFetch = vi.spyOn(client, "witnessFetch");
    const direct = directResult();
    const directFetch = vi.fn().mockResolvedValue(direct);

    const result = await client.attestedFetch(null, "https://target.example", { mode: "primary", directFetch });

    expect(result).toEqual({ witnessed: false, reason: "no_attestation", direct });
    expect(witnessFetch).not.toHaveBeenCalled();
  });

  it("passes method and body through to witnessFetch untouched", async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    const witnessFetch = vi.spyOn(client, "witnessFetch").mockResolvedValue(fakeWitness());

    await client.attestedFetch("att_1", "https://target.example", { method: "POST", body: { hello: 1 } });

    expect(witnessFetch).toHaveBeenCalledWith("att_1", "https://target.example", { method: "POST", body: { hello: 1 } });
  });
});

describe("OpenGlassClient.attestedFetch default directFetch", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString("utf8") }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("JSON-encodes body and reads the real response back, off a plain fetch", async () => {
    const client = new OpenGlassClient({ identity: fakeIdentity() });
    const result = await client.attestedFetch("att_1", baseUrl, { mode: "off", method: "POST", body: { a: 1 } });
    expect(result.witnessed).toBe(false);
    expect(result.direct?.status).toBe(200);
    const echoed = JSON.parse(result.direct!.body.toString("utf8"));
    expect(echoed).toEqual({ method: "POST", body: JSON.stringify({ a: 1 }) });
  });
});
