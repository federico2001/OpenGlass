import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { claimAgentDirectly, insertTestOwner, signedRequestHeaders, testIdentity, testServerDeps, type TestAgentIdentity } from "../helpers.js";

// `.invalid` never resolves (RFC 6761), so the platform's own card fetch finds nothing and
// no test makes a real outbound request.

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "rate_limits", "request_nonces", "unclaimed_profiles"]) await t.db.collection(c).deleteMany({});
});

function app(overrides: Partial<ReturnType<typeof testServerDeps>> = {}) {
  return buildServer({ ...testServerDeps(t), ...overrides, healthChecks: {} });
}

async function register(name: string, opts: { claim?: boolean; homepage?: string } = {}): Promise<TestAgentIdentity> {
  const identity = testIdentity(`prof_${name}`, `prof_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey, ...(opts.homepage ? { meta: { homepage: opts.homepage } } : {}) };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  if (opts.claim !== false) {
    const owner = await insertTestOwner(t.db, `${name}@example.com`);
    await claimAgentDirectly(t.db, identity.agentId, owner._id);
  }
  return identity;
}

async function list(identity: TestAgentIdentity, domain: string) {
  const body = { domain };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/profiles/unclaimed", body, identity });
  return app().inject({ method: "POST", url: "/v1/profiles/unclaimed", headers, payload: body });
}

describe("POST /v1/profiles/unclaimed", () => {
  it("requires a claimed agent", async () => {
    const identity = await register("unclaimed1", { claim: false });
    const res = await list(identity, "acme.invalid");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("agent_unclaimed");
  });

  it("lists a domain once and refreshes it on repeat, keeping who listed it first", async () => {
    const lister = await register("lister1");
    const other = await register("lister2");
    const first = await list(lister, "Acme.invalid");
    expect(first.statusCode).toBe(201);
    const profile = first.json().profile;
    expect(profile).toMatchObject({
      domain: "acme.invalid",
      agentCardUrl: null,
      cardSha256: null,
      listedBy: lister.agentId,
      claimed: false,
      claimedAgentId: null,
      profileUrl: "https://localhost/agents/by-domain/acme.invalid",
      claimUrl: "https://localhost/agents/by-domain/acme.invalid#claim",
    });

    const again = await list(other, "acme.invalid");
    expect(again.statusCode).toBe(200);
    expect(again.json().profile.listedBy).toBe(lister.agentId);
    expect(again.json().profile.listedAt).toBe(profile.listedAt);
  });

  it("rejects a malformed domain and one an agent already claims", async () => {
    const lister = await register("lister3");
    expect((await list(lister, "https://acme.invalid/x")).statusCode).toBe(422);

    const owner = await register("owner3", { homepage: "https://taken.invalid" });
    const res = await list(lister, "taken.invalid");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "already_registered", details: { agentId: owner.agentId } });
  });
});

describe("GET /v1/profiles/unclaimed/:domain and lookup", () => {
  it("is public, and lookup by domain reports the profile, even right after a cached miss", async () => {
    const lister = await register("lister4");
    const a = app();
    expect((await a.inject({ method: "GET", url: "/v1/lookup?domain=seen.invalid" })).json().unclaimedProfile).toBeNull();
    await list(lister, "seen.invalid");
    expect((await a.inject({ method: "GET", url: "/v1/lookup?domain=seen.invalid" })).json().unclaimedProfile).toMatchObject({ domain: "seen.invalid" });

    const res = await app().inject({ method: "GET", url: "/v1/profiles/unclaimed/seen.invalid" });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.domain).toBe("seen.invalid");
    expect((await app().inject({ method: "GET", url: "/v1/profiles/unclaimed/never.invalid" })).statusCode).toBe(404);

    const lookup = await app().inject({ method: "GET", url: "/v1/lookup?domain=seen.invalid" });
    expect(lookup.json()).toMatchObject({ registered: false, unclaimedProfile: { domain: "seen.invalid", claimed: false } });
  });

  it("is marked claimed when an agent verifies the domain", async () => {
    const lister = await register("lister5");
    await list(lister, "mine.invalid");
    const operator = await register("operator5", { homepage: "https://mine.invalid" });

    const verified = app({ checkDomainVerification: async () => true });
    const startHeaders = signedRequestHeaders({ method: "POST", path: "/v1/agents/me/domain-verification", identity: operator });
    expect((await verified.inject({ method: "POST", url: "/v1/agents/me/domain-verification", headers: startHeaders })).statusCode).toBe(201);
    const checkHeaders = signedRequestHeaders({ method: "POST", path: "/v1/agents/me/domain-verification/check", identity: operator });
    expect((await verified.inject({ method: "POST", url: "/v1/agents/me/domain-verification/check", headers: checkHeaders })).statusCode).toBe(200);

    const res = await app().inject({ method: "GET", url: "/v1/profiles/unclaimed/mine.invalid" });
    expect(res.json().profile).toMatchObject({ claimed: true, claimedAgentId: operator.agentId });
  });
});
