import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { createHash } from "node:crypto";
import {
  claimAgentDirectly,
  createOwnerSessionCookie,
  insertTestOwner,
  signedRequestHeaders,
  testIdentity,
  testServerDeps,
  type TestAgentIdentity,
} from "../helpers.js";

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
  for (const c of ["agents", "owners", "rate_limits", "request_nonces", "unclaimed_profiles", "profile_listings", "web_sessions"]) {
    await t.db.collection(c).deleteMany({});
  }
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
  return listBody(identity, { domain });
}

async function listBody(identity: TestAgentIdentity, body: Record<string, unknown>, server = app()) {
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/profiles/unclaimed", body, identity });
  return server.inject({ method: "POST", url: "/v1/profiles/unclaimed", headers, payload: body });
}

/** A fake card fetcher: serves `cards` by exact URL and records every URL asked for. */
function cardServer(cards: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchAgentCard = async (url: string) => {
    asked.push(url);
    if (!(url in cards)) return null;
    const json = cards[url];
    return { json, sha256: createHash("sha256").update(JSON.stringify(json)).digest("hex") };
  };
  return { asked, server: app({ fetchAgentCard }) };
}

async function ownerCookieFor(identity: TestAgentIdentity): Promise<string> {
  const agent = await t.db.collection("agents").findOne({ _id: identity.agentId as never });
  return createOwnerSessionCookie(t.db, agent!.ownerId as string);
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

describe("POST /v1/profiles/unclaimed with an agent card", () => {
  it("lists the counterparty from its agent card URL, storing the URL and hash the platform fetched", async () => {
    const lister = await register("card1");
    const cardUrl = "https://bot.acme.invalid/.well-known/agent-card.json";
    const { asked, server } = cardServer({ [cardUrl]: { name: "Acme Bot", url: "https://bot.acme.invalid/a2a" } });

    const res = await listBody(lister, { agentCardUrl: cardUrl }, server);
    expect(res.statusCode).toBe(201);
    expect(asked).toEqual([cardUrl]);
    expect(res.json().profile).toMatchObject({ domain: "bot.acme.invalid", agentCardUrl: cardUrl, claimed: false, listedBy: lister.agentId });
    expect(res.json().profile.cardSha256).toMatch(/^[0-9a-f]{64}$/);
    // Nothing the card says about itself is stored or echoed.
    expect(JSON.stringify(res.json())).not.toContain("Acme Bot");
  });

  it("refuses a card URL it won't fetch, and one with no card behind it", async () => {
    const lister = await register("card2");
    for (const bad of ["http://acme.invalid/card.json", "https://acme.invalid:8443/card.json", "https://10.0.0.1/card.json", "not a url"]) {
      const res = await listBody(lister, { agentCardUrl: bad });
      expect(res.statusCode, bad).toBe(422);
      expect(res.json().error.code).toBe("agent_card_url_invalid");
    }
    const res = await listBody(lister, { agentCardUrl: "https://gone.invalid/.well-known/agent-card.json" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("agent_card_unreachable");
    expect(await t.db.collection("unclaimed_profiles").countDocuments()).toBe(0);
  });

  it("answers already_registered when the card points back to an agent on OpenGlass", async () => {
    const lister = await register("card3");
    const registered = await register("card3b");
    const cardUrl = "https://elsewhere.invalid/.well-known/agent-card.json";
    const { server } = cardServer({ [cardUrl]: { name: "x", "x-openglass": { agentId: registered.agentId } } });
    const res = await listBody(lister, { agentCardUrl: cardUrl }, server);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "already_registered", details: { agentId: registered.agentId } });
  });

  it("takes the domain from an agent card passed inline, then fetches that domain's own card", async () => {
    const lister = await register("card4");
    const wellKnown = "https://svc.acme.invalid/.well-known/agent-card.json";
    const { asked, server } = cardServer({ [wellKnown]: { name: "Acme as served" } });

    const res = await listBody(lister, { agentCard: { name: "Acme as claimed", url: "https://svc.acme.invalid/a2a/v1" } }, server);
    expect(res.statusCode).toBe(201);
    expect(asked).toEqual([wellKnown]);
    expect(res.json().profile).toMatchObject({ domain: "svc.acme.invalid", agentCardUrl: wellKnown });

    // A2A 1.0 cards name their endpoints in supportedInterfaces.
    const v1 = await listBody(lister, { agentCard: { name: "n", supportedInterfaces: [{ url: "https://v1.acme.invalid/rpc" }] } });
    expect(v1.statusCode).toBe(201);
    expect(v1.json().profile.domain).toBe("v1.acme.invalid");
  });

  it("rejects an inline card with no usable url, and a body naming the counterparty twice", async () => {
    const lister = await register("card5");
    const noUrl = await listBody(lister, { agentCard: { name: "n", url: "http://10.0.0.1:8080/" } });
    expect(noUrl.statusCode).toBe(422);
    expect(noUrl.json().error.code).toBe("agent_card_invalid");
    const both = await listBody(lister, { domain: "a.invalid", agentCardUrl: "https://a.invalid/card.json" });
    expect(both.statusCode).toBe(400);
  });
});

describe("GET /v1/owner/counterparty-profiles", () => {
  it("lists what the owner's own agents listed, including profiles another agent listed first", async () => {
    const first = await register("own1");
    const second = await register("own2");
    const stranger = await register("own3");
    await list(first, "shared.invalid");
    await list(second, "shared.invalid");
    await list(stranger, "other.invalid");

    const res = await app().inject({ method: "GET", url: "/v1/owner/counterparty-profiles", headers: { cookie: await ownerCookieFor(second) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({
      listedByAgentId: second.agentId,
      profile: { domain: "shared.invalid", listedBy: first.agentId, claimed: false },
    });

    const firstItems = (await app().inject({ method: "GET", url: "/v1/owner/counterparty-profiles", headers: { cookie: await ownerCookieFor(first) } })).json().items;
    expect(firstItems.map((i: { profile: { domain: string } }) => i.profile.domain)).toEqual(["shared.invalid"]);
  });

  it("requires an owner session", async () => {
    expect((await app().inject({ method: "GET", url: "/v1/owner/counterparty-profiles" })).statusCode).toBe(401);
  });
});
