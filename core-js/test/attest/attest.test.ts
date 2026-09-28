import { base64UrlEncode, canonicalize, generateEd25519KeyPair, sha256, verifySignature, type AgentIdentity } from "openglass-sdk";
import { describe, expect, it, vi } from "vitest";
import { evaluateAndAttest, witnessIfRisky } from "../../src/attest/attest.js";
import type { AttestOptions } from "../../src/attest/types.js";
import { loadPolicy } from "../../src/policy/loadPolicy.js";
import type { Policy } from "../../src/policy/types.js";

const POLICY: Policy = loadPolicy({
  apiVersion: "openglass-policy/v1",
  kind: "Policy",
  metadata: { name: "test" },
  rules: [{ id: "risky-tool", risk: "high", when: { field: "attr:gen_ai.tool.name", op: "equals", value: "transfer_funds" } }],
});

function testIdentity(): AgentIdentity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { agentId: "agt_test0000000000000000000000", kid: "key_test0000000000000000000000", privateKey, publicKey };
}

/** A minimal in-memory attestations API: verifies the request signature is genuinely
 * correct (not just "some header was sent"), and tracks state across the
 * open -> event -> close sequence so the real evaluateAndAttest logic is exercised
 * end to end. */
function fakeOpenGlassServer(identity: AgentIdentity) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let genesisHash = "";
  let headSeq = 0;
  let headHash: string | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    // Normalized regardless of calling convention: `signedRequest` calls
    // `fetch(urlString, init)` directly, but `openapi-fetch` (used for the public
    // `lookup()`/`getAgent()`/etc. calls) constructs and passes a `Request` object
    // instead — `new Request(input, init)` handles both uniformly.
    const req = new Request(input, init);
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;
    const bodyStr = await req.clone().text();
    const body = bodyStr ? JSON.parse(bodyStr) : undefined;
    calls.push({ method, path, body });

    // Public, unsigned — realignment R7's counterparty-check path in evaluateAndAttest.
    if (method === "GET" && path === "/v1/lookup") {
      const agentId = url.searchParams.get("agentId");
      return Response.json({
        registered: true,
        agentId,
        name: "Counterparty",
        claimed: true,
        verifiedOwner: null,
        firstSeen: "2026-01-01T00:00:00.000Z",
        keyAgeDays: 1,
        software: null,
        activity: { sessionsLast90d: 0, attestationsLast90d: 0, distinctCounterparties: 0, normalCloseShare: null },
        openDisputesCount: 0,
        flags: { newAgent: true, unverifiedDomain: false, recentlyRotatedKey: false },
      });
    }

    const bodySha256 = Buffer.from(sha256(Buffer.from(bodyStr, "utf8"))).toString("hex");
    const digest = sha256(
      Buffer.from(
        canonicalize({ method, path, timestamp: req.headers.get("og-timestamp"), nonce: req.headers.get("og-nonce"), bodySha256 }),
        "utf8",
      ),
    );
    const valid = verifySignature(
      { alg: "Ed25519", kid: identity.kid, publicKey: identity.publicKey },
      "request",
      digest,
      { alg: "Ed25519", kid: req.headers.get("og-key")!, sig: req.headers.get("og-signature")! },
    );
    if (!valid) return new Response(JSON.stringify({ error: { code: "invalid_request_signature" } }), { status: 401 });

    if (method === "POST" && path === "/v1/attestations") {
      genesisHash = "a".repeat(64);
      return Response.json({ attestation: { id: body.open.attestationId, genesisHash, head: { seq: 0, hash: null } } }, { status: 201 });
    }
    if (method === "POST" && path.endsWith("/events")) {
      headSeq = body.envelope.seq;
      headHash = body.hash;
      return Response.json({ head: { seq: headSeq, hash: headHash } }, { status: 201 });
    }
    if (method === "POST" && path.endsWith("/close")) {
      return Response.json({ attestation: { status: "closing" } }, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  };

  return { fetchImpl, calls };
}

describe("evaluateAndAttest", () => {
  it("attests a high-risk event via a real open -> event -> close sequence with valid signatures", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    const result = await evaluateAndAttest(
      identity,
      POLICY,
      { attributes: { "gen_ai.tool.name": "transfer_funds" } },
      { fetchImpl: server.fetchImpl },
    );

    expect(result.attested).toBe(true);
    if (result.attested) {
      expect(result.attestationId).toMatch(/^att_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(result.matches.map((m) => m.id)).toEqual(["risky-tool"]);
    }
    expect(server.calls.map((c) => c.path)).toEqual([
      "/v1/attestations",
      expect.stringMatching(/\/v1\/attestations\/att_.+\/events/),
      expect.stringMatching(/\/v1\/attestations\/att_.+\/close/),
    ]);
  });

  it("defaults visibility to private, and sends it explicitly", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    const result = await evaluateAndAttest(identity, POLICY, { attributes: { "gen_ai.tool.name": "transfer_funds" } }, { fetchImpl: server.fetchImpl });

    expect(result.attested).toBe(true);
    const openCall = server.calls.find((c) => c.path === "/v1/attestations")!;
    expect((openCall.body as { visibility: string }).visibility).toBe("private");
  });

  it("runs an optional counterparty check and folds it into the attested payload, without ever blocking", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    const result = await evaluateAndAttest(
      identity,
      POLICY,
      { attributes: { "gen_ai.tool.name": "transfer_funds" } },
      { fetchImpl: server.fetchImpl, counterpartyAgentId: "agt_counterparty0000000000000" },
    );

    // A brand-new, unverified-domain-free counterparty defaults to "allow" — attesting
    // still proceeds regardless, since guard()'s verdict here is informational only.
    expect(result.attested).toBe(true);
    expect(server.calls.some((c) => c.path === "/v1/lookup")).toBe(true);
    const eventCall = server.calls.find((c) => c.path.endsWith("/events"))!;
    expect((eventCall.body as { payload: unknown }).payload).toBeUndefined(); // default mode "notary" — no payload leaves this process
  });

  it("includes the counterparty check in the payload when mode is relay", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    const result = await evaluateAndAttest(
      identity,
      POLICY,
      { attributes: { "gen_ai.tool.name": "transfer_funds" } },
      { fetchImpl: server.fetchImpl, mode: "relay", counterpartyAgentId: "agt_counterparty0000000000000" },
    );

    expect(result.attested).toBe(true);
    const eventCall = server.calls.find((c) => c.path.endsWith("/events"))!;
    const payload = (eventCall.body as { payload: { counterpartyCheck: { action: string; reason: string } } }).payload;
    expect(payload.counterpartyCheck.action).toBe("allow");
    expect(payload.counterpartyCheck.reason).toBe("first time seeing this counterparty");
  });

  it("does not attest a low-risk event, and never calls the API at all", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    const result = await evaluateAndAttest(identity, POLICY, { attributes: { "gen_ai.tool.name": "list_calendar" } }, { fetchImpl: server.fetchImpl });

    expect(result).toEqual({ attested: false, reason: "below_threshold", risk: "low", matches: [] });
    expect(server.calls).toHaveLength(0);
  });

  it("respects a lower minRisk threshold", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    const mediumPolicy = loadPolicy({
      apiVersion: "openglass-policy/v1",
      kind: "Policy",
      metadata: { name: "test" },
      rules: [{ id: "medium-rule", risk: "medium", when: { field: "field:a", op: "exists" } }],
    });
    const result = await evaluateAndAttest(identity, mediumPolicy, { fields: { a: 1 } }, { fetchImpl: server.fetchImpl, minRisk: "medium" });
    expect(result.attested).toBe(true);
  });

  it("fails open (returns, doesn't throw) when the API is unreachable, after retrying", async () => {
    const identity = testIdentity();
    let attempts = 0;
    const alwaysFails: typeof fetch = async () => {
      attempts++;
      throw new Error("network down");
    };
    const onError = vi.fn();
    const result = await evaluateAndAttest(
      identity,
      POLICY,
      { attributes: { "gen_ai.tool.name": "transfer_funds" } },
      { fetchImpl: alwaysFails, retries: 3, onError },
    );

    expect(result.attested).toBe(false);
    if (!result.attested) {
      expect(result.reason).toBe("api_unreachable");
      expect(result.risk).toBe("high");
    }
    expect(attempts).toBe(3);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("recovers after a transient failure within the retry budget", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    let openCalls = 0;
    const flaky: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/attestations" && openCalls++ === 0) throw new Error("transient");
      return server.fetchImpl(input, init);
    };
    const result = await evaluateAndAttest(identity, POLICY, { attributes: { "gen_ai.tool.name": "transfer_funds" } }, { fetchImpl: flaky, retries: 3 });
    expect(result.attested).toBe(true);
  });
});

describe("witnessIfRisky", () => {
  it("attests first, then always runs the wrapped action", async () => {
    const identity = testIdentity();
    const server = fakeOpenGlassServer(identity);
    const action = vi.fn().mockResolvedValue("action ran");
    const { result, attestation } = await witnessIfRisky(
      identity,
      POLICY,
      { attributes: { "gen_ai.tool.name": "transfer_funds" } },
      action,
      { fetchImpl: server.fetchImpl } satisfies AttestOptions,
    );
    expect(result).toBe("action ran");
    expect(attestation.attested).toBe(true);
    expect(action).toHaveBeenCalledOnce();
  });

  it("still runs the action when attestation fails open", async () => {
    const identity = testIdentity();
    const action = vi.fn().mockResolvedValue("action ran anyway");
    const { result, attestation } = await witnessIfRisky(
      identity,
      POLICY,
      { attributes: { "gen_ai.tool.name": "transfer_funds" } },
      action,
      { fetchImpl: async () => { throw new Error("down"); }, retries: 1, onError: () => {} },
    );
    expect(result).toBe("action ran anyway");
    expect(attestation.attested).toBe(false);
  });
});
