import { invitesRepository, newId, sessionsRepository } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { closeExpiredSessions } from "../../src/jobs/closeExpiredSessions.js";
import { buildActiveSession, testSigner } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages"]) await t.db.collection(c).deleteMany({});
});

describe("closeExpiredSessions", () => {
  it("moves an idle active session to closing with reason idle_timeout", async () => {
    const { session } = await buildActiveSession(t.db, { signer: testSigner() });
    const sessions = sessionsRepository(t.db);
    await sessions.update(session._id, { expiresAt: new Date(Date.now() - 1000) });

    const result = await closeExpiredSessions(t.db);
    expect(result.idleClosed).toBe(1);

    const updated = await sessions.findById(session._id);
    expect(updated!.status).toBe("closing");
    expect(updated!.closing!.reason).toBe("idle_timeout");
    expect(updated!.closing!.requestedBy).toBeNull();
  });

  it("expires a pending session and its invite together", async () => {
    const sessions = sessionsRepository(t.db);
    const invites = invitesRepository(t.db);
    const sessionId = newId("ses");
    const inviteId = newId("inv");
    const now = new Date();
    const past = new Date(Date.now() - 1000);

    await invites.insert({
      _id: inviteId,
      sessionId,
      fromAgentId: newId("agt"),
      kind: "open",
      toAgentId: null,
      tokenHash: "a".repeat(64),
      status: "pending",
      ownerApproval: null,
      expiresAt: past,
      createdAt: now,
      respondedAt: null,
    });
    await sessions.insert({
      _id: sessionId,
      mode: "relay",
      status: "pending",
      purpose: "x",
      initiator: { agentId: newId("agt"), ownerId: newId("own"), kid: newId("key") },
      counterparty: { agentId: null, ownerId: null, kid: null },
      inviteId,
      offer: {
        v: 1,
        type: "openglass.offer",
        sessionId,
        mode: "relay",
        purpose: "x",
        initiator: { agentId: newId("agt"), kid: newId("key"), publicKey: "A".repeat(43) },
        counterparty: null,
        idleTimeoutSec: 86400,
        createdAt: now.toISOString(),
        expiresAt: past.toISOString(),
      },
      offerSignature: { alg: "Ed25519", kid: newId("key"), sig: "c2ln" },
      accept: null,
      acceptSignature: null,
      genesisHash: null,
      genesisSignature: null,
      head: { seq: 0, hash: null },
      messageCount: 0,
      idleTimeoutSec: 86400,
      createdAt: now,
      activatedAt: null,
      lastActivityAt: now,
      expiresAt: past,
      closing: null,
      closedAt: null,
      recordId: null,
    });

    const result = await closeExpiredSessions(t.db);
    expect(result.expired).toBe(1);
    expect((await sessions.findById(sessionId))!.status).toBe("expired");
    expect((await invites.findById(inviteId))!.status).toBe("expired");
  });

  it("leaves unexpired sessions untouched", async () => {
    const { session } = await buildActiveSession(t.db, { signer: testSigner() });
    const result = await closeExpiredSessions(t.db);
    expect(result.idleClosed + result.expired).toBe(0);
    expect((await sessionsRepository(t.db).findById(session._id))!.status).toBe("active");
  });
});
