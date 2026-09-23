import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { createOwnerSessionCookie, insertTestOwner, signedRequestHeaders, testIdentity, testServerDeps } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "web_sessions", "request_nonces", "rate_limits"]) await t.db.collection(c).deleteMany({});
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAgent() {
  const identity = testIdentity("agt_claim", "key_claim");
  const body = { name: "Claimable Bot", description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  return { identity, agent: res.json().agent, claim: res.json().claim };
}

describe("GET /v1/claims/{token}", () => {
  it("previews an unclaimed agent by its claim token", async () => {
    const { claim, agent } = await registerAgent();
    const res = await app().inject({ method: "GET", url: `/v1/claims/${claim.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.id).toBe(agent.id);
  });

  it("returns 404 for an unknown token", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/claims/cl_does_not_exist" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/claims/{token}/accept", () => {
  it("claims the agent for the authenticated owner", async () => {
    const { claim, agent } = await registerAgent();
    const owner = await insertTestOwner(t.db, "alice@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);

    const res = await app().inject({
      method: "POST",
      url: `/v1/claims/${claim.token}/accept`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.status).toBe("active");
    expect(res.json().agent.ownerId).toBe(owner._id);
    expect(res.json().agent.id).toBe(agent.id);

    // the token is single-use: a second accept must 404.
    const again = await app().inject({
      method: "POST",
      url: `/v1/claims/${claim.token}/accept`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: {},
    });
    expect(again.statusCode).toBe(404);
  });

  it("rejects a claim attempt without a session cookie", async () => {
    const { claim } = await registerAgent();
    const res = await app().inject({
      method: "POST",
      url: `/v1/claims/${claim.token}/accept`,
      headers: { origin: "https://localhost", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a mismatched Origin header", async () => {
    const { claim } = await registerAgent();
    const owner = await insertTestOwner(t.db, "bob@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const res = await app().inject({
      method: "POST",
      url: `/v1/claims/${claim.token}/accept`,
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("origin_not_allowed");
  });
});
