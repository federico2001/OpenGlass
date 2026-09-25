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

describe("GET /v1/agents/{agentId}/agent.json", () => {
  it("returns an A2A-shaped card for the agent, falling back to its OpenGlass profile as url", async () => {
    const identity = testIdentity("agt_card", "key_card");
    const reg = await registerAgent(identity, { name: "Card Bot", description: "Has a card", meta: { software: "card-bot/1.2" } });
    const agentId = reg.json().agent.id as string;

    const res = await app().inject({ method: "GET", url: `/v1/agents/${agentId}/agent.json` });
    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.name).toBe("Card Bot");
    expect(card.description).toBe("Has a card");
    expect(card.version).toBe("card-bot/1.2");
    expect(card.url).toBe(`https://localhost/v1/agents/${agentId}`);
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false, stateTransitionHistory: false });
    expect(card["x-openglass"].agentId).toBe(agentId);
    expect(card["x-openglass"].claimed).toBe(false);
    expect(card["x-openglass"].keys).toHaveLength(1);
    expect(card["x-openglass"].keys[0].publicKey).toBe(identity.publicKey);
  });

  it("prefers the agent's own homepage as url when it has one", async () => {
    const identity = testIdentity("agt_home", "key_home");
    const reg = await registerAgent(identity, { name: "Homed Bot", meta: { homepage: "https://homed.example" } });
    const res = await app().inject({ method: "GET", url: `/v1/agents/${reg.json().agent.id}/agent.json` });
    expect(res.json().url).toBe("https://homed.example");
  });

  it("returns 404 for an unknown agent", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/agents/agt_00000000000000000000000000/agent.json" });
    expect(res.statusCode).toBe(404);
  });
});

describe("domain verification", () => {
  // Every describe above this one calls `registerAgent()` at least once, and only
  // "POST /v1/agents" resets `rate_limits` between tests — by the time execution
  // reaches here the shared agent_register bucket (10/hour, keyed by req.ip, and every
  // `.inject()` call shares the same ip) is close to exhausted. Reset it per-test so a
  // registration here never silently 429s and leaves `identity.agentId` pointing at a
  // placeholder that doesn't exist, which would surface as a confusing 401 instead of
  // whatever the test actually means to assert.
  beforeEach(async () => {
    await t.db.collection("rate_limits").deleteMany({});
  });

  function appWithCheck(result: boolean) {
    return buildServer({ ...testServerDeps(t), healthChecks: {}, checkDomainVerification: async () => result });
  }

  it("refuses to start without a real https meta.homepage", async () => {
    const identity = testIdentity("agt_dv_none", "key_dv_none");
    await registerAgent(identity); // no meta.homepage
    const path = "/v1/agents/me/domain-verification";
    const headers = signedRequestHeaders({ method: "POST", path, identity });
    const res = await app().inject({ method: "POST", url: path, headers });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("domain_invalid");
  });

  it("issues a pending token, then verifies once the check succeeds", async () => {
    const identity = testIdentity("agt_dv_ok", "key_dv_ok");
    await registerAgent(identity, { meta: { homepage: "https://acme.example" } });

    const startPath = "/v1/agents/me/domain-verification";
    const startHeaders = signedRequestHeaders({ method: "POST", path: startPath, identity });
    const startRes = await app().inject({ method: "POST", url: startPath, headers: startHeaders });
    expect(startRes.statusCode).toBe(201);
    expect(startRes.json().domainVerification.domain).toBe("acme.example");
    expect(startRes.json().domainVerification.status).toBe("pending");
    expect(startRes.json().verifyUrl).toBe("https://acme.example/.well-known/openglass-agent-verification.txt");
    expect(startRes.json().instructions).toContain(startRes.json().domainVerification.token);

    // not yet published — the check fails
    const checkPath = "/v1/agents/me/domain-verification/check";
    const checkHeaders = signedRequestHeaders({ method: "POST", path: checkPath, identity });
    const failRes = await appWithCheck(false).inject({ method: "POST", url: checkPath, headers: checkHeaders });
    expect(failRes.statusCode).toBe(422);
    expect(failRes.json().error.code).toBe("domain_verification_failed");

    // published — the check succeeds
    const okHeaders = signedRequestHeaders({ method: "POST", path: checkPath, identity });
    const okRes = await appWithCheck(true).inject({ method: "POST", url: checkPath, headers: okHeaders });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().domainVerification.status).toBe("verified");
    expect(okRes.json().domainVerification.verifiedAt).toBeTruthy();

    // both the agent's own full view and its public view now show it verified
    const mePath = "/v1/agents/me";
    const meRes = await app().inject({ method: "GET", url: mePath, headers: signedRequestHeaders({ method: "GET", path: mePath, identity }) });
    expect(meRes.json().agent.domainVerified).toBe(true);
    const publicRes = await app().inject({ method: "GET", url: `/v1/agents/${identity.agentId}` });
    expect(publicRes.json().agent.domainVerified).toBe(true);
    expect(publicRes.json().agent.domainVerification).toBeUndefined(); // token stays private to the agent's own view
  });

  it("requires a domain-verification request before checking", async () => {
    const identity = testIdentity("agt_dv_unrequested", "key_dv_unrequested");
    await registerAgent(identity, { meta: { homepage: "https://acme2.example" } });
    const path = "/v1/agents/me/domain-verification/check";
    const headers = signedRequestHeaders({ method: "POST", path, identity });
    const res = await appWithCheck(true).inject({ method: "POST", url: path, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("domain_verification_not_requested");
  });

  it("clears verification when meta.homepage changes", async () => {
    const identity = testIdentity("agt_dv_change", "key_dv_change");
    await registerAgent(identity, { meta: { homepage: "https://acme3.example" } });

    const startPath = "/v1/agents/me/domain-verification";
    await app().inject({ method: "POST", url: startPath, headers: signedRequestHeaders({ method: "POST", path: startPath, identity }) });
    const checkPath = "/v1/agents/me/domain-verification/check";
    const verifyRes = await appWithCheck(true).inject({
      method: "POST",
      url: checkPath,
      headers: signedRequestHeaders({ method: "POST", path: checkPath, identity }),
    });
    expect(verifyRes.json().domainVerification.status).toBe("verified");

    const patchPath = "/v1/agents/me";
    const patchBody = { meta: { homepage: "https://different.example" } };
    const patchHeaders = signedRequestHeaders({ method: "PATCH", path: patchPath, body: patchBody, identity });
    const patchRes = await app().inject({ method: "PATCH", url: patchPath, headers: patchHeaders, payload: patchBody });
    expect(patchRes.json().agent.domainVerified).toBe(false);
    expect(patchRes.json().agent.domainVerification).toBeNull();
  });
});
