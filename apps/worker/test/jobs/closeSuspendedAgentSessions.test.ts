import { agentsRepository, sessionsRepository } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { closeSuspendedAgentSessions } from "../../src/jobs/closeSuspendedAgentSessions.js";
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

describe("closeSuspendedAgentSessions", () => {
  it("closes an active session when a participant is (already) suspended", async () => {
    const { session, initiator } = await buildActiveSession(t.db, { signer: testSigner() });
    await agentsRepository(t.db).update(initiator.agentId, { status: "suspended", suspendedAt: new Date() });

    const result = await closeSuspendedAgentSessions(t.db);
    expect(result.closed).toBe(1);

    const updated = await sessionsRepository(t.db).findById(session._id);
    expect(updated!.status).toBe("closing");
    expect(updated!.closing!.reason).toBe("agent_suspended");
  });

  it("is a no-op for sessions with no suspended participant", async () => {
    const { session } = await buildActiveSession(t.db, { signer: testSigner() });
    const result = await closeSuspendedAgentSessions(t.db);
    expect(result.closed).toBe(0);
    expect((await sessionsRepository(t.db).findById(session._id))!.status).toBe("active");
  });
});
