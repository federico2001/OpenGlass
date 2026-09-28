import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentsRepository, migrate, newId, records as recordsCollection, sessions as sessionsCollection, type AgentDoc, type RecordDoc, type SessionDoc } from "@openglass/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { validDocs } from "../../../../packages/db/test/fixtures.js";
import { createLookupService } from "../../src/domain/lookup.js";
import { testIdentity } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeEach(async () => {
  t = await openTestDb();
  const migrationsDir = await mkdtemp(path.join(tmpdir(), "og-migrations-"));
  await migrate(t.db, t.client, { migrationsDir });
});
afterEach(async () => {
  await t.cleanup();
});

const PUBLIC_URL = "https://localhost";

async function insertAgent(overrides: Partial<AgentDoc> = {}): Promise<AgentDoc> {
  const now = new Date();
  return agentsRepository(t.db).insert({
    _id: newId("agt"),
    name: "Test Agent",
    description: "",
    meta: {},
    keys: [{ kid: newId("key"), alg: "Ed25519", publicKey: testIdentity("x", "y").publicKey, createdAt: now, revokedAt: null }],
    ownerId: newId("own"),
    status: "active",
    claim: null,
    claimedAt: now,
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

async function insertSession(overrides: Partial<SessionDoc>): Promise<void> {
  const base = validDocs.sessions as unknown as SessionDoc;
  const doc: SessionDoc = { ...base, _id: newId("ses"), inviteId: newId("inv"), ...overrides };
  await t.db.collection<SessionDoc>(sessionsCollection.name).insertOne(doc);
}

describe("lookup: registered agents", () => {
  it("finds an agent by agentId, publicKey, and homepageDomain, and reports firstSeen/keyAgeDays", async () => {
    const agent = await insertAgent({ meta: { homepage: "https://acme.example" }, homepageDomain: "acme.example" } as Partial<AgentDoc>);
    const lookup = createLookupService(t.db);

    const byId = await lookup.lookupAgent({ agentId: agent._id }, PUBLIC_URL);
    expect(byId.registered).toBe(true);
    if (byId.registered) {
      expect(byId.agentId).toBe(agent._id);
      expect(byId.name).toBe("Test Agent");
      expect(byId.claimed).toBe(true);
      expect(byId.firstSeen).toBe(agent.createdAt.toISOString());
      expect(byId.keyAgeDays).toBe(0);
    }

    const byKey = await lookup.lookupAgent({ publicKey: agent.keys[0]!.publicKey }, PUBLIC_URL);
    expect(byKey.registered).toBe(true);

    const byDomain = await lookup.lookupAgent({ domain: "acme.example" }, PUBLIC_URL);
    expect(byDomain.registered).toBe(true);
    if (byDomain.registered) {
      expect(byDomain.agentId).toBe(agent._id);
      expect(byDomain.flags.unverifiedDomain).toBe(true); // claimed a homepage, never verified it
      expect(byDomain.verifiedOwner).toBeNull();
    }
  });

  it("prefers a verified domainVerification match over an unverified homepageDomain match", async () => {
    const verifiedAgent = await insertAgent({
      name: "Verified Co",
      meta: { homepage: "https://shared.example" },
      homepageDomain: "shared.example",
      domainVerification: { domain: "shared.example", token: "t", status: "verified", requestedAt: new Date(), verifiedAt: new Date() },
    } as Partial<AgentDoc>);
    await insertAgent({ name: "Unverified Co", meta: { homepage: "https://shared.example" }, homepageDomain: "shared.example" } as Partial<AgentDoc>);

    const result = await createLookupService(t.db).lookupAgent({ domain: "shared.example" }, PUBLIC_URL);
    expect(result.registered).toBe(true);
    if (result.registered) {
      expect(result.agentId).toBe(verifiedAgent._id);
      expect(result.verifiedOwner).toEqual({ domain: "shared.example" });
      expect(result.flags.unverifiedDomain).toBe(false);
    }
  });

  it("flags a brand-new agent and a recently rotated key", async () => {
    const now = new Date();
    const agent = await insertAgent({
      createdAt: new Date(now.getTime() - 100 * 24 * 3_600_000), // established, not new
      keys: [
        { kid: newId("key"), alg: "Ed25519", publicKey: testIdentity("a", "b").publicKey, createdAt: new Date(now.getTime() - 100 * 24 * 3_600_000), revokedAt: now },
        { kid: newId("key"), alg: "Ed25519", publicKey: testIdentity("c", "d").publicKey, createdAt: now, revokedAt: null },
      ],
    } as Partial<AgentDoc>);

    const result = await createLookupService(t.db).lookupAgent({ agentId: agent._id }, PUBLIC_URL);
    expect(result.registered).toBe(true);
    if (result.registered) {
      expect(result.flags.newAgent).toBe(false);
      expect(result.flags.recentlyRotatedKey).toBe(true);
    }
  });

  it("open disputes count reflects sealedState.status === disputed records the agent participates in", async () => {
    const agent = await insertAgent();
    const baseRecord = validDocs.records as unknown as RecordDoc;
    await t.db.collection<RecordDoc>(recordsCollection.name).insertOne({
      ...baseRecord,
      _id: newId("rec"),
      sessionId: newId("ses"),
      participantAgentIds: [agent._id, newId("agt")],
      visibility: "sealed",
      sealedState: { status: "disputed", requestedBy: null, approvals: [], unsealedAt: null, disputedBy: agent.ownerId, disputedAt: new Date() },
    });

    const result = await createLookupService(t.db).lookupAgent({ agentId: agent._id }, PUBLIC_URL);
    expect(result.registered).toBe(true);
    if (result.registered) expect(result.openDisputesCount).toBe(1);
  });
});

describe("lookup: activity facts anti-gaming (realignment R2)", () => {
  it("only counts sessions whose counterparty is itself domain-verified", async () => {
    const agent = await insertAgent();
    const verifiedCounterparty = await insertAgent({
      domainVerification: { domain: "verified.example", token: "t", status: "verified", requestedAt: new Date(), verifiedAt: new Date() },
    } as Partial<AgentDoc>);
    const unverifiedCounterparty = await insertAgent();

    await insertSession({
      initiator: { agentId: agent._id, ownerId: agent.ownerId, kid: agent.keys[0]!.kid },
      counterparty: { agentId: verifiedCounterparty._id, ownerId: verifiedCounterparty.ownerId, kid: verifiedCounterparty.keys[0]!.kid },
      createdAt: new Date(),
      status: "closed",
      closing: { reason: "agent_closed", requestedBy: agent._id, statement: null, signature: null, requestedAt: new Date() },
    } as Partial<SessionDoc>);
    await insertSession({
      initiator: { agentId: agent._id, ownerId: agent.ownerId, kid: agent.keys[0]!.kid },
      counterparty: { agentId: unverifiedCounterparty._id, ownerId: unverifiedCounterparty.ownerId, kid: unverifiedCounterparty.keys[0]!.kid },
      createdAt: new Date(),
      status: "closed",
      closing: { reason: "agent_closed", requestedBy: agent._id, statement: null, signature: null, requestedAt: new Date() },
    } as Partial<SessionDoc>);

    const result = await createLookupService(t.db).lookupAgent({ agentId: agent._id }, PUBLIC_URL);
    expect(result.registered).toBe(true);
    if (result.registered) {
      // only the session with the verified counterparty counts
      expect(result.activity.sessionsLast90d).toBe(1);
      expect(result.activity.distinctCounterparties).toBe(1);
      expect(result.activity.normalCloseShare).toBe(1);
    }
  });

  it("excludes sessions outside the 90-day window", async () => {
    const agent = await insertAgent();
    const verifiedCounterparty = await insertAgent({
      domainVerification: { domain: "verified2.example", token: "t", status: "verified", requestedAt: new Date(), verifiedAt: new Date() },
    } as Partial<AgentDoc>);

    await insertSession({
      initiator: { agentId: agent._id, ownerId: agent.ownerId, kid: agent.keys[0]!.kid },
      counterparty: { agentId: verifiedCounterparty._id, ownerId: verifiedCounterparty.ownerId, kid: verifiedCounterparty.keys[0]!.kid },
      createdAt: new Date(Date.now() - 200 * 24 * 3_600_000), // well outside the 90-day window
      status: "closed",
      closing: { reason: "agent_closed", requestedBy: agent._id, statement: null, signature: null, requestedAt: new Date() },
    } as Partial<SessionDoc>);

    const result = await createLookupService(t.db).lookupAgent({ agentId: agent._id }, PUBLIC_URL);
    expect(result.registered).toBe(true);
    if (result.registered) expect(result.activity.sessionsLast90d).toBe(0);
  });

  it("normalCloseShare is null (not 0) when there are no closed sessions yet to judge", async () => {
    const agent = await insertAgent();
    const result = await createLookupService(t.db).lookupAgent({ agentId: agent._id }, PUBLIC_URL);
    expect(result.registered).toBe(true);
    if (result.registered) expect(result.activity.normalCloseShare).toBeNull();
  });
});

describe("lookup: unregistered agents", () => {
  it("reports registered: false with an inviteUrl for an agentId that doesn't exist", async () => {
    const result = await createLookupService(t.db).lookupAgent({ agentId: "agt_doesnotexist00000000000000" }, PUBLIC_URL);
    expect(result.registered).toBe(false);
    if (!result.registered) expect(result.inviteUrl).toBe(`${PUBLIC_URL}/skill.md`);
  });

  it("reports registered: false for a domain that resolves to no known agent, without crashing on external enrichment", async () => {
    // .invalid is reserved by RFC 2606 to never resolve — this exercises the "external
    // enrichment fails gracefully" path without depending on a specific real domain's
    // current DNS/RDAP/MCP-registry state.
    const result = await createLookupService(t.db).lookupAgent({ domain: "this-domain-should-not-resolve.invalid" }, PUBLIC_URL);
    expect(result.registered).toBe(false);
    if (!result.registered) {
      expect(result.agentCard).toBeNull();
      expect(result.domainRegisteredAt).toBeNull();
    }
  });
});
