import { agentsRepository, newId } from "@openglass/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { registerRawBodyCapture } from "../../src/plugins/rawBody.js";
import { registerPremiumRoutes, requireWithinSpendLimit } from "../../src/routes/premium.js";
import { buildServer } from "../../src/server.js";
import {
  claimAgentDirectly,
  createOwnerSessionCookie,
  insertTestOwner,
  signedRequestHeaders,
  testIdentity,
  testServerDeps,
} from "../helpers.js";

/**
 * Owner-set spend limits on an agent's own x402 premium purchases. The enforcement hook
 * (requireWithinSpendLimit) has to run before x402's paymentMiddleware — see its own doc
 * comment in routes/premium.ts for why that means reading an unverified OG-Agent header —
 * so it's exercised directly here, the same way premiumPaymentGuard.test.ts exercises
 * requireExistingRecordForPremiumRoutes: no real x402 resourceServer, which needs a funded
 * on-chain wallet (scripts/x402-test-agent.ts) to test for real.
 */
describe("requireWithinSpendLimit", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>;

  beforeAll(async () => {
    t = await openTestDb();
  });
  afterAll(() => t.cleanup());

  function buildGuardedApp(): FastifyInstance {
    const app = Fastify({ logger: false });
    app.addHook("onRequest", requireWithinSpendLimit(t.db));
    app.post("/v1/premium/agents/me/verified-badge", async () => ({ reached: "badge" }));
    app.post("/v1/premium/records/:recordId/extend-retention", async () => ({ reached: "extend-retention" }));
    app.get("/v1/premium/records/:recordId/pdf", async () => ({ reached: "pdf" }));
    return app;
  }

  async function insertAgentWithLimit(limitCents: number | null, spentCents: number): Promise<string> {
    const agents = agentsRepository(t.db);
    const now = new Date();
    const doc = await agents.insert({
      _id: newId("agt"),
      name: "Spend Test Agent",
      description: "",
      meta: {},
      keys: [{ kid: newId("key"), alg: "Ed25519", publicKey: testIdentity("x", "y").publicKey, createdAt: now, revokedAt: null }],
      ownerId: null,
      status: "unclaimed",
      claim: null,
      claimedAt: null,
      suspendedAt: null,
      createdAt: now,
      updatedAt: now,
      spendLimitUsdCents: limitCents,
      totalSpendUsdCents: spentCents,
    });
    return doc._id;
  }

  it("blocks a premium route once the purchase would exceed the agent's limit", async () => {
    const agentId = await insertAgentWithLimit(100, 60); // $1.00 limit, $0.60 already spent
    const app = buildGuardedApp();
    // extend-retention is $0.50 — $0.60 + $0.50 = $1.10 > $1.00 limit
    const res = await app.inject({
      method: "POST",
      url: "/v1/premium/records/rec_whatever/extend-retention",
      headers: { "og-agent": agentId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("spend_limit_exceeded");
  });

  it("allows a purchase that lands exactly at the limit", async () => {
    const agentId = await insertAgentWithLimit(50, 0); // $0.50 limit, nothing spent yet
    const app = buildGuardedApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/premium/records/rec_whatever/extend-retention",
      headers: { "og-agent": agentId },
    });
    expect(res.statusCode).toBe(200);
  });

  it("never blocks an agent with no limit set", async () => {
    const agentId = await insertAgentWithLimit(null, 1_000_000);
    const app = buildGuardedApp();
    const res = await app.inject({ method: "POST", url: "/v1/premium/agents/me/verified-badge", headers: { "og-agent": agentId } });
    expect(res.statusCode).toBe(200);
  });

  it("passes through a request with no OG-Agent header (an owner call, not agent spend)", async () => {
    const app = buildGuardedApp();
    const res = await app.inject({ method: "GET", url: "/v1/premium/records/rec_whatever/pdf" });
    expect(res.statusCode).toBe(200);
  });

  it("passes through an unknown agent id — real auth will reject it properly", async () => {
    const app = buildGuardedApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/premium/agents/me/verified-badge",
      headers: { "og-agent": "agt_00000000000000000000000000" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("PATCH /v1/owner/agents/{id}/spend-limit", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>;
  beforeAll(async () => {
    t = await openTestDb();
  });
  afterAll(() => t.cleanup());

  function app() {
    return buildServer({ ...testServerDeps(t), healthChecks: {} });
  }

  async function registerAndClaimFor(name: string, ownerId: string) {
    const identity = testIdentity(`spend_${name}`, `spend_key_${name}`);
    const body = { name, description: "d", publicKey: identity.publicKey };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
    const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    identity.agentId = res.json().agent.id;
    identity.kid = res.json().agent.keys[0].kid;
    await claimAgentDirectly(t.db, identity.agentId, ownerId);
    return identity;
  }

  it("sets and clears an agent's spend limit, only for its own owner", async () => {
    const owner = await insertTestOwner(t.db, `owner_${newId("own").slice(-6)}@example.com`.toLowerCase());
    const stranger = await insertTestOwner(t.db, `stranger_${newId("own").slice(-6)}@example.com`.toLowerCase());
    const agent = await registerAndClaimFor(`agent_${newId("agt").slice(-6)}`, owner._id);
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const strangerCookie = await createOwnerSessionCookie(t.db, stranger._id);

    const path = `/v1/owner/agents/${agent.agentId}/spend-limit`;
    const setRes = await app().inject({
      method: "PATCH",
      url: path,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { spendLimitUsdCents: 500 },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().agent.spendLimitUsdCents).toBe(500);
    expect(setRes.json().agent.totalSpendUsdCents).toBe(0);

    const clearRes = await app().inject({
      method: "PATCH",
      url: path,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { spendLimitUsdCents: null },
    });
    expect(clearRes.json().agent.spendLimitUsdCents).toBeNull();

    const strangerRes = await app().inject({
      method: "PATCH",
      url: path,
      headers: { cookie: strangerCookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { spendLimitUsdCents: 100 },
    });
    expect(strangerRes.statusCode).toBe(404);
  });
});

describe("premium routes track an agent's own spend", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>;
  let app: FastifyInstance; // full server, for registration/claim
  let premiumApp: FastifyInstance; // premium routes only, no real x402 gating in front

  beforeAll(async () => {
    t = await openTestDb();
    const deps = testServerDeps(t);
    app = buildServer({ ...deps, healthChecks: {} });
    premiumApp = Fastify({ logger: false });
    registerRawBodyCapture(premiumApp);
    const cookie = await import("@fastify/cookie");
    await premiumApp.register(cookie.default);
    registerPremiumRoutes(premiumApp, { ...deps, healthChecks: {} });
  });
  afterAll(() => t.cleanup());

  it("adds the route's price to the agent's lifetime total once the (already-paid-for) action runs", async () => {
    const identity = testIdentity(`spend_track_${newId("agt").slice(-6)}`, `spend_track_key_${newId("key").slice(-6)}`);
    const body = { name: "Tracker", description: "d", publicKey: identity.publicKey };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
    const regRes = await app.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    identity.agentId = regRes.json().agent.id;
    identity.kid = regRes.json().agent.keys[0].kid;
    const owner = await insertTestOwner(t.db, `tracker_${newId("own").slice(-6)}@example.com`.toLowerCase());
    await claimAgentDirectly(t.db, identity.agentId, owner._id);

    const badgePath = "/v1/premium/agents/me/verified-badge";
    const badgeHeaders = signedRequestHeaders({ method: "POST", path: badgePath, identity });
    const badgeRes = await premiumApp.inject({ method: "POST", url: badgePath, headers: badgeHeaders });
    expect(badgeRes.statusCode).toBe(200);
    expect(badgeRes.json().agent.totalSpendUsdCents).toBe(100);
  });
});
