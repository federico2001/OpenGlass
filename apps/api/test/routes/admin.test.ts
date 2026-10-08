import { newId } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { claimAgentDirectly, createOwnerSessionCookie, insertTestOwner, signedRequestHeaders, testIdentity, testServerDeps } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "web_sessions", "sessions", "attestations", "records", "fetch_witnesses", "checkup_events", "rate_limits", "request_nonces"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAgent(name: string, homepage?: string) {
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: `${name} description`, publicKey: identity.publicKey, ...(homepage ? { meta: { homepage } } : {}) };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  expect(res.statusCode).toBe(201);
  return res.json().agent.id as string;
}

describe("GET /v1/admin/stats", () => {
  it("requires sign-in", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/admin/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("403s a signed-in owner who isn't in ADMIN_EMAILS", async () => {
    const owner = await insertTestOwner(t.db, "someone@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const res = await app().inject({ method: "GET", url: "/v1/admin/stats", headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("itemizes what the /live numbers count, matching /v1/live", async () => {
    const admin = await insertTestOwner(t.db, "admin@example.com");
    const cookie = await createOwnerSessionCookie(t.db, admin._id);
    const claimed = await registerAgent("Claimed agent", "https://claimed.example.com");
    const unclaimed = await registerAgent("Unclaimed agent");
    await claimAgentDirectly(t.db, claimed, admin._id);

    // Only the fields these aggregations read: skip building fully signed documents.
    const attestationId = newId("att");
    await t.db.collection("attestations").insertOne({ _id: attestationId, status: "closed", attestor: { agentId: claimed }, createdAt: new Date() } as never, {
      bypassDocumentValidation: true,
    });
    await t.db.collection("records").insertMany(
      [
        { _id: newId("rec"), statement: { kind: "attestation" }, participantAgentIds: [claimed], createdAt: new Date() },
        { _id: newId("rec"), statement: { kind: "session" }, participantAgentIds: [claimed, unclaimed], createdAt: new Date() },
      ] as never[],
      { bypassDocumentValidation: true },
    );
    await t.db.collection("fetch_witnesses").insertMany(
      [
        { _id: newId("wfx"), requestedBy: claimed, domain: "external.example.org", fetchedAt: new Date() },
        { _id: newId("wfx"), requestedBy: claimed, domain: "claimed.example.com", fetchedAt: new Date() },
      ] as never[],
      { bypassDocumentValidation: true },
    );
    await t.db.collection("checkup_events").insertMany([
      { kind: "check_run", source: "registry", targetKey: "https://external.example.org", reportId: null, at: new Date() },
      { kind: "check_run", source: "user", targetKey: "https://external.example.org", reportId: null, at: new Date() },
    ]);

    const res = await app().inject({ method: "GET", url: "/v1/admin/stats", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const live = (await app().inject({ method: "GET", url: "/v1/live" })).json().stats;
    expect(body.live).toEqual({
      activeAgents: live.activeAgents,
      registeredAgents: 1,
      witnessedDomains: 1,
      sessionsStarted: live.sessionsStarted,
      sessionRecords: live.sessionRecords,
      attestationRecords: live.attestationRecords,
    });
    expect(body.live.activeAgents).toBe(2);

    const byId = Object.fromEntries(body.agents.map((a: { id: string }) => [a.id, a]));
    expect(byId[claimed]).toMatchObject({ name: "Claimed agent", countedAsActive: true, ownerEmail: "admin@example.com", attestations: 1 });
    expect(byId[unclaimed]).toMatchObject({ countedAsActive: false, ownerEmail: null });

    const domains = Object.fromEntries(body.witnessedDomains.map((d: { domain: string }) => [d.domain, d]));
    expect(domains["external.example.org"]).toMatchObject({ countedAsActive: true, fetches: 1, requestedBy: [{ id: claimed, name: "Claimed agent" }] });
    expect(domains["claimed.example.com"].countedAsActive).toBe(false);

    expect(body.attestations.recordsByAgent).toEqual([{ id: claimed, name: "Claimed agent", records: 1 }]);
    expect(body.attestations.byStatus).toEqual({ closed: 1 });
    expect(body.checkup.events).toEqual([
      { kind: "check_run", source: "registry", count: 1 },
      { kind: "check_run", source: "user", count: 1 },
    ]);
  });
});
