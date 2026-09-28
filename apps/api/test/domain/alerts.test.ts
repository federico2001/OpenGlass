import { agentsRepository, newId, ownersRepository, sessions as sessionsCollection, type AgentDoc, type OwnerDoc, type SessionDoc } from "@openglass/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { validDocs } from "../../../../packages/db/test/fixtures.js";
import { notifyCounterpartyAlerts, notifyDisputeRaised, notifyHighRiskAction } from "../../src/domain/alerts.js";
import { createCapturingMailer } from "../../src/mailer.js";
import { testIdentity } from "../helpers.js";

/** Realignment R4 (docs/SPEC.md §15): the four oversight-alert triggers, exercised directly
 * against the domain functions (same "insert fixtures, call the domain function, assert on
 * the capturing mailer" style as domain/lookup.test.ts) rather than through the HTTP routes
 * that call them, since the routing plumbing itself is already covered by the existing
 * invites/attestations/sealing route tests. */

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeEach(async () => {
  t = await openTestDb();
});
afterEach(async () => {
  await t.cleanup();
});

const PUBLIC_URL = "https://localhost";

async function insertOwner(overrides: Partial<OwnerDoc> = {}): Promise<OwnerDoc> {
  const base = validDocs.owners as unknown as OwnerDoc;
  return ownersRepository(t.db).insert({ ...base, _id: newId("own"), email: `${newId("own").slice(-6)}@example.com`, ...overrides });
}

async function insertAgent(ownerId: string, overrides: Partial<AgentDoc> = {}): Promise<AgentDoc> {
  const now = new Date();
  return agentsRepository(t.db).insert({
    _id: newId("agt"),
    name: `Agent ${newId("agt").slice(-6)}`,
    description: "",
    meta: {},
    keys: [{ kid: newId("key"), alg: "Ed25519", publicKey: testIdentity("x", "y").publicKey, createdAt: now, revokedAt: null }],
    ownerId,
    status: "active",
    claim: null,
    claimedAt: now,
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

async function insertSession(initiator: AgentDoc, counterparty: AgentDoc, overrides: Partial<SessionDoc> = {}): Promise<SessionDoc> {
  const base = validDocs.sessions as unknown as SessionDoc;
  const doc: SessionDoc = {
    ...base,
    _id: newId("ses"),
    inviteId: newId("inv"),
    initiator: { agentId: initiator._id, ownerId: initiator.ownerId!, kid: initiator.keys[0]!.kid },
    counterparty: { agentId: counterparty._id, ownerId: counterparty.ownerId!, kid: counterparty.keys[0]!.kid },
    status: "active",
    ...overrides,
  };
  await t.db.collection<SessionDoc>(sessionsCollection.name).insertOne(doc);
  return doc;
}

describe("notifyCounterpartyAlerts", () => {
  it("alerts both owners of a brand-new, unverified counterparty", async () => {
    const ownerA = await insertOwner();
    const ownerB = await insertOwner();
    const agentA = await insertAgent(ownerA._id);
    const agentB = await insertAgent(ownerB._id);
    const session = await insertSession(agentA, agentB);
    const mailer = createCapturingMailer();

    await notifyCounterpartyAlerts(t.db, mailer, console, session, PUBLIC_URL);

    const kindsFor = (email: string) => mailer.sent.filter((m) => m.to === email).map((m) => m.alertKind).sort();
    expect(kindsFor(ownerA.email)).toEqual(["new_counterparty", "unverified_counterparty"]);
    expect(kindsFor(ownerB.email)).toEqual(["new_counterparty", "unverified_counterparty"]);
  });

  it("skips new_counterparty once the pair has a prior session, but still flags an unverified domain", async () => {
    const ownerA = await insertOwner();
    const ownerB = await insertOwner();
    const agentA = await insertAgent(ownerA._id);
    const agentB = await insertAgent(ownerB._id);
    await insertSession(agentA, agentB, { status: "closed" }); // a prior session between the same two owners
    const session = await insertSession(agentA, agentB);
    const mailer = createCapturingMailer();

    await notifyCounterpartyAlerts(t.db, mailer, console, session, PUBLIC_URL);

    const kindsFor = (email: string) => mailer.sent.filter((m) => m.to === email).map((m) => m.alertKind);
    expect(kindsFor(ownerA.email)).toEqual(["unverified_counterparty"]);
    expect(kindsFor(ownerB.email)).toEqual(["unverified_counterparty"]);
  });

  it("doesn't flag unverified_counterparty when the other agent's domain is verified", async () => {
    const ownerA = await insertOwner();
    const ownerB = await insertOwner();
    const agentA = await insertAgent(ownerA._id);
    const agentB = await insertAgent(ownerB._id, {
      domainVerification: { domain: "acme.example", token: "tok", status: "verified", requestedAt: new Date(), verifiedAt: new Date() },
    });
    const session = await insertSession(agentA, agentB);
    const mailer = createCapturingMailer();

    await notifyCounterpartyAlerts(t.db, mailer, console, session, PUBLIC_URL);

    expect(mailer.sent.filter((m) => m.to === ownerA.email).map((m) => m.alertKind)).toEqual(["new_counterparty"]);
  });

  it("sends nothing to an owner who has turned oversight alerts off", async () => {
    const ownerA = await insertOwner({ settings: { requireInviteApproval: false, emailOnRecord: true, oversightAlerts: false } });
    const ownerB = await insertOwner();
    const agentA = await insertAgent(ownerA._id);
    const agentB = await insertAgent(ownerB._id);
    const session = await insertSession(agentA, agentB);
    const mailer = createCapturingMailer();

    await notifyCounterpartyAlerts(t.db, mailer, console, session, PUBLIC_URL);

    expect(mailer.sent.some((m) => m.to === ownerA.email)).toBe(false);
    expect(mailer.sent.some((m) => m.to === ownerB.email)).toBe(true);
  });
});

describe("notifyHighRiskAction", () => {
  it("alerts the attestor's owner when the payload carries a high-risk verdict", async () => {
    const owner = await insertOwner();
    const mailer = createCapturingMailer();

    await notifyHighRiskAction(t.db, mailer, console, owner._id, newId("att"), { verdict: { risk: "high", matches: [{ id: "financial-transaction" }] } }, PUBLIC_URL);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: owner.email, alertKind: "high_risk_action" });
    expect(mailer.sent[0]!.detail).toContain("financial-transaction");
  });

  it("does nothing for a low/medium-risk or missing verdict", async () => {
    const owner = await insertOwner();
    const mailer = createCapturingMailer();

    await notifyHighRiskAction(t.db, mailer, console, owner._id, newId("att"), { verdict: { risk: "low" } }, PUBLIC_URL);
    await notifyHighRiskAction(t.db, mailer, console, owner._id, newId("att"), undefined, PUBLIC_URL);
    await notifyHighRiskAction(t.db, mailer, console, owner._id, newId("att"), { text: "plain relay payload, no verdict at all" }, PUBLIC_URL);

    expect(mailer.sent).toHaveLength(0);
  });

  it("sends nothing when the owner has turned oversight alerts off", async () => {
    const owner = await insertOwner({ settings: { requireInviteApproval: false, emailOnRecord: true, oversightAlerts: false } });
    const mailer = createCapturingMailer();

    await notifyHighRiskAction(t.db, mailer, console, owner._id, newId("att"), { verdict: { risk: "high", matches: [] } }, PUBLIC_URL);

    expect(mailer.sent).toHaveLength(0);
  });
});

describe("notifyDisputeRaised", () => {
  it("alerts every participant owner except the one who raised the dispute", async () => {
    const ownerA = await insertOwner();
    const ownerB = await insertOwner();
    const mailer = createCapturingMailer();

    await notifyDisputeRaised(t.db, mailer, console, newId("rec"), [ownerA._id, ownerB._id], ownerA._id, PUBLIC_URL);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: ownerB.email, alertKind: "dispute_raised" });
  });
});
