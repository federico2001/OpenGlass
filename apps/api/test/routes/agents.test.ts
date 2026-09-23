import { canonicalizeToBytes, sha256, signEd25519, sigInput, base64UrlEncode, generateEd25519KeyPair } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { signedRequestHeaders, testIdentity, testServerDeps } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAgent(identity: ReturnType<typeof testIdentity>, overrides: Record<string, unknown> = {}) {
  const body = { name: "Acme Bot", description: "Buys things", publicKey: identity.publicKey, ...overrides };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  // `identity.agentId`/`identity.kid` were only ever test-local placeholders; sync them
  // to the server-assigned ids so subsequent (non-self-signed) signed requests authenticate.
  if (res.statusCode === 201) {
    identity.agentId = res.json().agent.id;
    identity.kid = res.json().agent.keys[0].kid;
  }
  return res;
}

describe("POST /v1/agents", () => {
  beforeEach(async () => {
    for (const c of ["agents", "request_nonces", "rate_limits"]) await t.db.collection(c).deleteMany({});
  });

  it("registers a new agent and returns a claim token/url", async () => {
    const identity = testIdentity("agt_pending", "key_pending");
    const res = await registerAgent(identity);
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.agent.status).toBe("unclaimed");
    expect(json.agent.keys).toHaveLength(1);
    expect(json.agent.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(json.claim.token).toBeTruthy();
    expect(json.claim.url).toContain(json.claim.token);
  });

  it("rejects a second agent registering the same public key", async () => {
    const identity = testIdentity("agt_dup", "key_dup");
    const first = await registerAgent(identity);
    expect(first.statusCode).toBe(201);
    const second = await registerAgent(identity);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("key_in_use");
  });

  it("rejects a request signed with a different key than the one being registered", async () => {
    const identity = testIdentity("agt_x", "key_x");
    const otherKeyPair = generateEd25519KeyPair();
    const body = { name: "Acme Bot", description: "d", publicKey: base64UrlEncode(otherKeyPair.publicKey) };
    // Sign with `identity`'s key, but the body claims a different publicKey — the
    // verifier checks the signature against body.publicKey, so this must fail.
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
    const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_request_signature");
  });
});

describe("GET/PATCH /v1/agents/me", () => {
  it("returns the authenticated agent's own full view", async () => {
    const identity = testIdentity("agt_me", "key_me");
    const reg = await registerAgent(identity);
    expect(reg.statusCode).toBe(201);

    const headers = signedRequestHeaders({ method: "GET", path: "/v1/agents/me", identity });
    const res = await app().inject({ method: "GET", url: "/v1/agents/me", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.id).toBe(reg.json().agent.id);
    expect(res.json().agent.ownerId).toBeNull();
  });

  it("updates name/description via PATCH", async () => {
    const identity = testIdentity("agt_patch", "key_patch");
    await registerAgent(identity);
    const body = { name: "Renamed Bot" };
    const headers = signedRequestHeaders({ method: "PATCH", path: "/v1/agents/me", body, identity });
    const res = await app().inject({ method: "PATCH", url: "/v1/agents/me", headers, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.name).toBe("Renamed Bot");
  });

  it("rejects an unsigned request", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/agents/me" });
    expect(res.statusCode).toBe(401);
  });
});

describe("agent key management", () => {
  it("adds a new key with a valid proof signature, then revokes the original", async () => {
    const identity = testIdentity("agt_keys", "key_a");
    const reg = await registerAgent(identity);
    expect(reg.statusCode).toBe(201);

    const newKeyPair = generateEd25519KeyPair();
    const newPublicKey = base64UrlEncode(newKeyPair.publicKey);
    const createdAt = new Date().toISOString();
    const digest = sha256(canonicalizeToBytes({ agentId: reg.json().agent.id, publicKey: newPublicKey, createdAt }));
    const proofSig = base64UrlEncode(signEd25519(sigInput("key", digest), newKeyPair.privateKey));
    const addBody = { publicKey: newPublicKey, createdAt, proof: { alg: "Ed25519", kid: "new", sig: proofSig } };
    const addHeaders = signedRequestHeaders({ method: "POST", path: "/v1/agents/me/keys", body: addBody, identity });
    const addRes = await app().inject({ method: "POST", url: "/v1/agents/me/keys", headers: addHeaders, payload: addBody });
    expect(addRes.statusCode).toBe(201);
    const newKid = addRes.json().key.kid;

    const revokeHeaders = signedRequestHeaders({ method: "DELETE", path: `/v1/agents/me/keys/${identity.kid}`, identity });
    const revokeRes = await app().inject({ method: "DELETE", url: `/v1/agents/me/keys/${identity.kid}`, headers: revokeHeaders });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().key.revokedAt).not.toBeNull();

    // now only `newKid` is active — revoking it too must be rejected as the last key.
    const identity2 = { ...identity, kid: newKid, privateKey: newKeyPair.privateKey };
    const lastHeaders = signedRequestHeaders({ method: "DELETE", path: `/v1/agents/me/keys/${newKid}`, identity: identity2 });
    const lastRes = await app().inject({ method: "DELETE", url: `/v1/agents/me/keys/${newKid}`, headers: lastHeaders });
    expect(lastRes.statusCode).toBe(409);
    expect(lastRes.json().error.code).toBe("last_key");
  });

  it("rejects an add-key request whose proof doesn't verify", async () => {
    const identity = testIdentity("agt_badproof", "key_badproof");
    await registerAgent(identity);
    const newKeyPair = generateEd25519KeyPair();
    const body = {
      publicKey: base64UrlEncode(newKeyPair.publicKey),
      createdAt: new Date().toISOString(),
      proof: { alg: "Ed25519", kid: "new", sig: base64UrlEncode(new Uint8Array(64)) },
    };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents/me/keys", body, identity });
    const res = await app().inject({ method: "POST", url: "/v1/agents/me/keys", headers, payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_signature");
  });
});

describe("GET /v1/agents/{agentId}", () => {
  it("returns the public view without ownerId", async () => {
    const identity = testIdentity("agt_public", "key_public");
    const reg = await registerAgent(identity);
    const res = await app().inject({ method: "GET", url: `/v1/agents/${reg.json().agent.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.ownerId).toBeUndefined();
    expect(res.json().agent.claimed).toBe(false);
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/agents/agt_00000000000000000000000000" });
    expect(res.statusCode).toBe(404);
  });
});
