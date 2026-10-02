import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { claimAgentDirectly, insertTestOwner, signedRequestHeaders, testIdentity, testServerDeps } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "rate_limits", "request_nonces"]) await t.db.collection(c).deleteMany({});
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAndClaim(name: string) {
  const a = app();
  const identity = testIdentity(`lookup_${name}`, `lookup_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await a.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}@example.com`);
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return identity;
}

describe("GET /v1/lookup", () => {
  it("requires exactly one of agentId, domain, agentCardUrl, publicKey", async () => {
    expect((await app().inject({ method: "GET", url: "/v1/lookup" })).statusCode).toBe(400);
    expect((await app().inject({ method: "GET", url: "/v1/lookup?agentId=agt_x&domain=acme.example" })).statusCode).toBe(400);
  });

  it("needs no authentication and finds a registered agent by id", async () => {
    const identity = await registerAndClaim("public1");
    const res = await app().inject({ method: "GET", url: `/v1/lookup?agentId=${identity.agentId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.registered).toBe(true);
    expect(body.agentId).toBe(identity.agentId);
    expect(body.activity).toEqual({ sessionsLast90d: 0, attestationsLast90d: 0, distinctCounterparties: 0, normalCloseShare: null });
    expect(body.openDisputesCount).toBe(0);
    expect(body.flags.newAgent).toBe(true);
    expect(body.software).toBeNull();
  });

  it("reports registered: false with an inviteUrl for an unknown agent, and sets RateLimit headers", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/lookup?agentId=agt_00000000000000000000000000" });
    expect(res.statusCode).toBe(200);
    expect(res.json().registered).toBe(false);
    expect(res.json().inviteUrl).toBe("https://localhost/skill.md");
    expect(res.headers["ratelimit-limit"]).toBeTruthy();
  });

  it("doesn't cache a publicKey miss, so an agent finds itself right after registering", async () => {
    const a = app();
    const identity = testIdentity("lookup_fresh", "lookup_fresh_key");
    const query = `/v1/lookup?publicKey=${identity.publicKey}`;
    expect((await a.inject({ method: "GET", url: query })).json().registered).toBe(false);

    const body = { name: "fresh", description: "d", publicKey: identity.publicKey };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
    const reg = await a.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    expect((await a.inject({ method: "GET", url: query })).json()).toMatchObject({ registered: true, agentId: reg.json().agent.id });
  });

  it("rejects a malformed domain", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/lookup?domain=not_a_domain!!" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("domain_invalid");
  });
});
