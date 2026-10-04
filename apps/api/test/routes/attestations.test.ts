import { agentsRepository, canonicalizeToBytes, hex, newId, sha256, signEd25519, base64UrlEncode, sigInput } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WitnessFetchResponse, WitnessFetchResult } from "../../src/domain/witnessFetch.js";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer, type ServerDeps } from "../../src/server.js";
import {
  buildAttestationOpen,
  claimAgentDirectly,
  createOwnerSessionCookie,
  insertTestOwner,
  signedRequestHeaders,
  testContentEncryptionDeps,
  testIdentity,
  testServerDeps,
  type TestAgentIdentity,
} from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "attestations", "messages", "records", "fetch_witnesses", "rate_limits"]) await t.db.collection(c).deleteMany({});
});

function app(overrides: Partial<ServerDeps> = {}) {
  return buildServer({ ...testServerDeps(t), healthChecks: {}, ...overrides });
}

/** A fake performWitnessFetch, standing in for the real network call the same way
 * profiles.test.ts fakes fetchAgentCard — no real server, no SSRF guard exercised here. */
function fakeWitnessFetch(responseOverrides: Partial<WitnessFetchResponse> = {}): () => Promise<WitnessFetchResult> {
  return async () => ({
    ok: true,
    response: {
      status: 200,
      headers: { "content-type": "text/plain" },
      contentType: "text/plain",
      bodySha256: hex(sha256(Buffer.from("hello from the other side"))),
      bodyBytes: 25,
      bodyTruncated: false,
      bodyText: "hello from the other side",
      ...responseOverrides,
    },
  });
}

async function registerAndClaim(name: string): Promise<TestAgentIdentity> {
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}@example.com`);
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return identity;
}

async function openAttestation(
  attestor: TestAgentIdentity,
  attestationId = newId("att"),
  opts: { visibility?: "private" | "sealed" | "shared"; server?: ReturnType<typeof app> } = {},
) {
  const { open, openSignature } = buildAttestationOpen({ attestationId, attestor });
  const body = { open, openSignature, ...(opts.visibility ? { visibility: opts.visibility } : {}) };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/attestations", body, identity: attestor });
  const res = await (opts.server ?? app()).inject({ method: "POST", url: "/v1/attestations", headers, payload: body });
  return res;
}

describe("POST /v1/attestations", () => {
  it("activates immediately — no counterparty, no accept step", async () => {
    const attestor = await registerAndClaim(`open_${newId("agt").slice(-6)}`);
    const res = await openAttestation(attestor);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.attestation.status).toBe("active");
    expect(body.attestation.eventCount).toBe(0);
    expect(body.attestation.genesisHash).toBeTruthy();
    expect(body.attestation.activatedAt).toBeTruthy();
  });

  it("rejects an unclaimed agent", async () => {
    const identity = testIdentity(`unclaimed_${newId("agt").slice(-6)}`, `k_${newId("agt").slice(-6)}`);
    const body = { name: identity.agentId, description: "d", publicKey: identity.publicKey };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
    const registerRes = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    identity.agentId = registerRes.json().agent.id;
    identity.kid = registerRes.json().agent.keys[0].kid;

    const res = await openAttestation(identity);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("agent_unclaimed");
  });

  it("rejects open.attestor.agentId that doesn't match the authenticated agent", async () => {
    const a = await registerAndClaim(`mismatch_a_${newId("agt").slice(-6)}`);
    const b = await registerAndClaim(`mismatch_b_${newId("agt").slice(-6)}`);
    const { open, openSignature } = buildAttestationOpen({ attestationId: newId("att"), attestor: b });
    const body = { open, openSignature };
    // Signed by b's key, but the request is authenticated as a — og-agent says a.
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/attestations", body, identity: a });
    const res = await app().inject({ method: "POST", url: "/v1/attestations", headers: { ...headers, "og-agent": a.agentId }, payload: body });
    expect(res.statusCode).toBe(422);
  });
});

describe("POST /v1/attestations visibility (realignment R1, docs/SPEC.md §13)", () => {
  it("defaults to private when content encryption is configured", async () => {
    const attestor = await registerAndClaim(`vis_default_${newId("agt").slice(-6)}`);
    const server = buildServer({ ...testServerDeps(t), healthChecks: {}, contentEncryption: testContentEncryptionDeps() });
    const res = await openAttestation(attestor, undefined, { server });
    expect(res.statusCode).toBe(201);
    expect(res.json().attestation.visibility).toBe("private");
  });

  it("falls back from the default private to shared (never sealed) when content encryption isn't configured", async () => {
    const attestor = await registerAndClaim(`vis_fallback_${newId("agt").slice(-6)}`);
    const res = await openAttestation(attestor); // app() (top of file) has contentEncryption: null
    expect(res.statusCode).toBe(201);
    expect(res.json().attestation.visibility).toBe("shared");
  });

  it("honors an explicit shared request", async () => {
    const attestor = await registerAndClaim(`vis_shared_${newId("agt").slice(-6)}`);
    const res = await openAttestation(attestor, undefined, { visibility: "shared" });
    expect(res.statusCode).toBe(201);
    expect(res.json().attestation.visibility).toBe("shared");
  });
});

describe("POST /v1/attestations/:id/events", () => {
  it("hash-chains events, countersigns each, and rejects a stale head", async () => {
    const attestor = await registerAndClaim(`events_${newId("agt").slice(-6)}`);
    const openRes = await openAttestation(attestor);
    const attestationId = openRes.json().attestation.id;
    const genesisHash = openRes.json().attestation.genesisHash;

    function canonicalize(value: unknown): string {
      if (value === null || value === undefined) return "null";
      if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
      if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }

    function buildEvent(seq: number, prevHash: string, text: string) {
      const payload = { text };
      const payloadHash = hex(sha256(Buffer.from(canonicalize(payload), "utf8")));
      const envelope = {
        v: 1, type: "openglass.message", sessionId: attestationId, seq, prevHash,
        sender: { agentId: attestor.agentId, kid: attestor.kid }, contentType: "application/json", payloadHash,
        sentAt: new Date().toISOString(),
      };
      const hashBytes = sha256(Buffer.concat([Buffer.from(prevHash, "hex"), Buffer.from(canonicalize(envelope), "utf8")]));
      const hash = hex(hashBytes);
      const signature = { alg: "Ed25519" as const, kid: attestor.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), attestor.privateKey)) };
      return { envelope, hash, signature, payload };
    }

    const event1 = buildEvent(1, genesisHash, "Called payment-tool with $500 to acct_123");
    const path = `/v1/attestations/${attestationId}/events`;
    const headers1 = signedRequestHeaders({ method: "POST", path, body: event1, identity: attestor });
    const res1 = await app().inject({ method: "POST", url: path, headers: headers1, payload: event1 });
    expect(res1.statusCode).toBe(201);
    expect(res1.json().head).toEqual({ seq: 1, hash: event1.hash });

    // Replaying seq 1 again (stale head) must 409.
    const headersReplay = signedRequestHeaders({ method: "POST", path, body: event1, identity: attestor });
    const resReplay = await app().inject({ method: "POST", url: path, headers: headersReplay, payload: event1 });
    expect(resReplay.statusCode).toBe(409);
    expect(resReplay.json().error.code).toBe("chain_conflict");

    const event2 = buildEvent(2, event1.hash, "Payment confirmed");
    const headers2 = signedRequestHeaders({ method: "POST", path, body: event2, identity: attestor });
    const res2 = await app().inject({ method: "POST", url: path, headers: headers2, payload: event2 });
    expect(res2.statusCode).toBe(201);

    const listRes = await app().inject({ method: "GET", url: path, headers: signedRequestHeaders({ method: "GET", path, identity: attestor }) });
    expect(listRes.json().items).toHaveLength(2);
  });
});

describe("POST /v1/attestations/:id/witness-fetch", () => {
  it("fetches, chains off genesisHash, and the second fetch chains off the first", async () => {
    const attestor = await registerAndClaim(`wfx_${newId("agt").slice(-6)}`);
    const server = app({ performWitnessFetch: fakeWitnessFetch() });
    const openRes = await openAttestation(attestor, undefined, { server });
    const attestationId = openRes.json().attestation.id;
    const genesisHash = openRes.json().attestation.genesisHash;

    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body1 = { url: "https://example.com/offer" };
    const headers1 = signedRequestHeaders({ method: "POST", path, body: body1, identity: attestor });
    const res1 = await server.inject({ method: "POST", url: path, headers: headers1, payload: body1 });
    expect(res1.statusCode).toBe(201);
    const witness1 = res1.json().witness;
    expect(witness1.seq).toBe(1);
    expect(witness1.prevHash).toBe(genesisHash);
    expect(witness1.requestedBy).toBe(attestor.agentId);
    expect(witness1.response.bodyText).toBe("hello from the other side");
    expect(witness1.platformSignature.alg).toBe("ECDSA_P256_SHA256");

    const body2 = { url: "https://example.com/accept" };
    const headers2 = signedRequestHeaders({ method: "POST", path, body: body2, identity: attestor });
    const res2 = await server.inject({ method: "POST", url: path, headers: headers2, payload: body2 });
    expect(res2.statusCode).toBe(201);
    const witness2 = res2.json().witness;
    expect(witness2.seq).toBe(2);
    expect(witness2.prevHash).toBe(witness1.hash);

    const listRes = await server.inject({
      method: "GET",
      url: `/v1/attestations/${attestationId}/witnesses`,
      headers: signedRequestHeaders({ method: "GET", path: `/v1/attestations/${attestationId}/witnesses`, identity: attestor }),
    });
    expect(listRes.json().items.map((w: { seq: number }) => w.seq)).toEqual([1, 2]);
  });

  it("rejects a non-https URL without attempting any fetch", async () => {
    const attestor = await registerAndClaim(`wfx_scheme_${newId("agt").slice(-6)}`);
    const openRes = await openAttestation(attestor);
    const attestationId = openRes.json().attestation.id;
    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body = { url: "http://example.com/offer" };
    const res = await app().inject({ method: "POST", url: path, headers: signedRequestHeaders({ method: "POST", path, body, identity: attestor }), payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("url_invalid");
  });

  it("rejects an IP-literal host", async () => {
    const attestor = await registerAndClaim(`wfx_ip_${newId("agt").slice(-6)}`);
    const openRes = await openAttestation(attestor);
    const attestationId = openRes.json().attestation.id;
    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body = { url: "https://93.184.216.34/offer" };
    const res = await app().inject({ method: "POST", url: path, headers: signedRequestHeaders({ method: "POST", path, body, identity: attestor }), payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("url_invalid");
  });

  it("reports url_unreachable when the fetch itself fails", async () => {
    const attestor = await registerAndClaim(`wfx_unreach_${newId("agt").slice(-6)}`);
    const server = app({ performWitnessFetch: async () => ({ ok: false, reason: "The request failed or timed out" }) });
    const openRes = await openAttestation(attestor, undefined, { server });
    const attestationId = openRes.json().attestation.id;
    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body = { url: "https://example.com/offer" };
    const res = await server.inject({ method: "POST", url: path, headers: signedRequestHeaders({ method: "POST", path, body, identity: attestor }), payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("url_unreachable");
  });

  it("404s for an agent that isn't this attestation's attestor", async () => {
    const attestor = await registerAndClaim(`wfx_owner_${newId("agt").slice(-6)}`);
    const stranger = await registerAndClaim(`wfx_stranger_${newId("agt").slice(-6)}`);
    const server = app({ performWitnessFetch: fakeWitnessFetch() });
    const openRes = await openAttestation(attestor, undefined, { server });
    const attestationId = openRes.json().attestation.id;
    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body = { url: "https://example.com/offer" };
    const res = await server.inject({ method: "POST", url: path, headers: signedRequestHeaders({ method: "POST", path, body, identity: stranger }), payload: body });
    expect(res.statusCode).toBe(404);
  });

  it("409s once the attestation is no longer active", async () => {
    const attestor = await registerAndClaim(`wfx_closed_${newId("agt").slice(-6)}`);
    const server = app({ performWitnessFetch: fakeWitnessFetch() });
    const openRes = await openAttestation(attestor, undefined, { server });
    const attestationId = openRes.json().attestation.id;

    const statement = { v: 1, type: "openglass.close", sessionId: attestationId, headSeq: 0, headHash: null, closedAt: new Date().toISOString() };
    const closeSig = {
      alg: "Ed25519" as const,
      kid: attestor.kid,
      sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), attestor.privateKey)),
    };
    const closePath = `/v1/attestations/${attestationId}/close`;
    const closeBody = { statement, signature: closeSig };
    await server.inject({
      method: "POST",
      url: closePath,
      headers: signedRequestHeaders({ method: "POST", path: closePath, body: closeBody, identity: attestor }),
      payload: closeBody,
    });

    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body = { url: "https://example.com/offer" };
    const res = await server.inject({ method: "POST", url: path, headers: signedRequestHeaders({ method: "POST", path, body, identity: attestor }), payload: body });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("attestation_not_active");
  });
});

describe("GET /v1/attestations/:id/witnesses access", () => {
  it("is readable by the attestor's owner, and 404s for an unrelated owner", async () => {
    const attestor = await registerAndClaim(`wfx_read_${newId("agt").slice(-6)}`);
    const server = app({ performWitnessFetch: fakeWitnessFetch() });
    const openRes = await openAttestation(attestor, undefined, { server });
    const attestationId = openRes.json().attestation.id;
    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body = { url: "https://example.com/offer" };
    await server.inject({ method: "POST", url: path, headers: signedRequestHeaders({ method: "POST", path, body, identity: attestor }), payload: body });

    const doc = await agentsRepository(t.db).findById(attestor.agentId);
    const ownerCookie = await createOwnerSessionCookie(t.db, doc!.ownerId!);
    const listPath = `/v1/attestations/${attestationId}/witnesses`;
    const okRes = await server.inject({ method: "GET", url: listPath, headers: { cookie: ownerCookie } });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().items).toHaveLength(1);

    const otherOwner = await insertTestOwner(t.db, `wfx_other_${newId("own").slice(-6)}@example.com`);
    const otherCookie = await createOwnerSessionCookie(t.db, otherOwner._id);
    const deniedRes = await server.inject({ method: "GET", url: listPath, headers: { cookie: otherCookie } });
    expect(deniedRes.statusCode).toBe(404);
  });
});

describe("POST /v1/attestations/:id/close and GET /v1/attestations/:id", () => {
  it("closes at the current head and is readable by the attestor's owner", async () => {
    const attestor = await registerAndClaim(`close_${newId("agt").slice(-6)}`);
    const openRes = await openAttestation(attestor);
    const attestationId = openRes.json().attestation.id;

    const statement = {
      v: 1, type: "openglass.close", sessionId: attestationId, headSeq: 0, headHash: null,
      closedAt: new Date().toISOString(),
    };
    const closeSig = {
      alg: "Ed25519" as const,
      kid: attestor.kid,
      sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), attestor.privateKey)),
    };
    const closePath = `/v1/attestations/${attestationId}/close`;
    const closeBody = { statement, signature: closeSig };
    const closeHeaders = signedRequestHeaders({ method: "POST", path: closePath, body: closeBody, identity: attestor });
    const closeRes = await app().inject({ method: "POST", url: closePath, headers: closeHeaders, payload: closeBody });
    expect(closeRes.statusCode).toBe(202);
    expect(closeRes.json().attestation.status).toBe("closing");

    const doc = await agentsRepository(t.db).findById(attestor.agentId);
    const ownerCookie = await createOwnerSessionCookie(t.db, doc!.ownerId!);
    const getRes = await app().inject({ method: "GET", url: `/v1/attestations/${attestationId}`, headers: { cookie: ownerCookie } });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().attestation.status).toBe("closing");
  });

  it("404s for an unrelated owner", async () => {
    const attestor = await registerAndClaim(`priv_${newId("agt").slice(-6)}`);
    const openRes = await openAttestation(attestor);
    const attestationId = openRes.json().attestation.id;

    const otherOwner = await insertTestOwner(t.db, `other_${newId("own").slice(-6)}@example.com`);
    const cookie = await createOwnerSessionCookie(t.db, otherOwner._id);
    const res = await app().inject({ method: "GET", url: `/v1/attestations/${attestationId}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });
});
