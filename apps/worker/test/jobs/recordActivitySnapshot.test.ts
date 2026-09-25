import { activitySnapshotsRepository } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { recordActivitySnapshot } from "../../src/jobs/recordActivitySnapshot.js";
import { buildActiveSession, testSigner } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "activity_snapshots"]) await t.db.collection(c).deleteMany({});
});

const NULL_STATS = {
  npmWeeklyDownloads: null,
  pypiDailyDownloads: null,
  pypiWeeklyDownloads: null,
  pypiMonthlyDownloads: null,
  github: { stars: null, forks: null, watchers: null, openIssues: null },
};

describe("recordActivitySnapshot", () => {
  it("writes today's counts derived from real data", async () => {
    await buildActiveSession(t.db, { signer: testSigner(), messageCount: 3 });
    const now = new Date("2026-03-01T12:00:00Z");

    const result = await recordActivitySnapshot(t.db, { now, fetchStats: async () => NULL_STATS });
    expect(result.written).toBe(true);

    const doc = await activitySnapshotsRepository(t.db).findById("2026-03-01");
    expect(doc).not.toBeNull();
    expect(doc!.agents.total).toBe(2);
    expect(doc!.agents.active).toBe(2);
    expect(doc!.owners.total).toBe(2);
    expect(doc!.sessions.total).toBe(1);
    expect(doc!.sessions.active).toBe(1);
    expect(doc!.messages.total).toBe(3);
    expect(doc!.records.total).toBe(0);
    expect(doc!.packages).toEqual({
      npmWeeklyDownloads: null,
      pypiDailyDownloads: null,
      pypiWeeklyDownloads: null,
      pypiMonthlyDownloads: null,
    });
    expect(doc!.github).toEqual({ stars: null, forks: null, watchers: null, openIssues: null });
  });

  it("is a no-op the second time it runs the same UTC day", async () => {
    const now = new Date("2026-03-01T08:00:00Z");
    const first = await recordActivitySnapshot(t.db, { now, fetchStats: async () => NULL_STATS });
    expect(first.written).toBe(true);

    await buildActiveSession(t.db, { signer: testSigner() }); // data changes...
    const later = new Date("2026-03-01T20:00:00Z"); // ...but still the same UTC day
    const second = await recordActivitySnapshot(t.db, { now: later, fetchStats: async () => NULL_STATS });
    expect(second.written).toBe(false);

    const doc = await activitySnapshotsRepository(t.db).findById("2026-03-01");
    expect(doc!.agents.total).toBe(0); // reflects the first run, not the later data
  });

  it("writes a new document for a new UTC day", async () => {
    await recordActivitySnapshot(t.db, { now: new Date("2026-03-01T08:00:00Z"), fetchStats: async () => NULL_STATS });
    const nextDay = await recordActivitySnapshot(t.db, { now: new Date("2026-03-02T08:00:00Z"), fetchStats: async () => NULL_STATS });
    expect(nextDay.written).toBe(true);

    const repo = activitySnapshotsRepository(t.db);
    expect(await repo.findById("2026-03-01")).not.toBeNull();
    expect(await repo.findById("2026-03-02")).not.toBeNull();
  });
});
