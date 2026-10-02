import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openTestDb } from "./testDb.js";

const A = "agt_01JNK3TVHVMWN55JM1DBXHKRAA";
const B = "agt_01JNK3TVHVMWN55JM1DBXHKRBB";
const MIGRATION = new URL("../migrations/20261002200000-backfill_profile_listings.js", import.meta.url).href;

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeEach(async () => {
  t = await openTestDb();
  await migrate(t.db, t.client, { migrationsDir: await mkdtemp(path.join(tmpdir(), "og-migrations-")) });
});
afterEach(async () => {
  await t.cleanup();
});

describe("backfill_profile_listings", () => {
  it("adds the first lister of every existing profile, once, and keeps newer listings", async () => {
    const listedAt = new Date("2026-10-01T00:00:00Z");
    const lastSeenAt = new Date("2026-10-02T00:00:00Z");
    const base = { agentCardUrl: null, cardSha256: null, cardFetchedAt: null, claimedAgentId: null, claimedAt: null };
    await t.db.collection("unclaimed_profiles").insertMany([
      { _id: "a.example", listedBy: A, listedAt, lastSeenAt, ...base },
      { _id: "b.example", listedBy: B, listedAt, lastSeenAt, ...base },
    ] as never);
    const later = new Date("2026-10-03T00:00:00Z");
    await t.db
      .collection("profile_listings")
      .insertOne({ _id: `${A}|a.example`, agentId: A, domain: "a.example", firstListedAt: listedAt, lastListedAt: later } as never);

    const { up } = (await import(MIGRATION)) as { up: (db: typeof t.db, client: typeof t.client) => Promise<void> };
    await up(t.db, t.client);
    await up(t.db, t.client);

    const rows = await t.db.collection("profile_listings").find({}).sort({ _id: 1 }).toArray();
    expect(rows).toEqual([
      { _id: `${A}|a.example`, agentId: A, domain: "a.example", firstListedAt: listedAt, lastListedAt: later },
      { _id: `${B}|b.example`, agentId: B, domain: "b.example", firstListedAt: listedAt, lastListedAt: lastSeenAt },
    ]);
  });
});
