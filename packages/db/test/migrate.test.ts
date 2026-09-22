import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { migrate } from "../src/migrate.js";
import { allCollections, migrationLock } from "../src/models/collections.js";
import { defineCollection } from "../src/models/define.js";
import { toBsonSchema } from "../src/jsonSchema.js";
import { invalidDocs, validDocs } from "./fixtures.js";
import { openTestDb } from "./testDb.js";

const reportedCollections = allCollections.filter((c) => c !== migrationLock).map((c) => c.name).sort();

let t: Awaited<ReturnType<typeof openTestDb>>;
let emptyMigrations: string;

beforeEach(async () => {
  t = await openTestDb();
  emptyMigrations = await mkdtemp(path.join(tmpdir(), "og-migrations-"));
});
afterEach(async () => {
  await t.cleanup();
});

describe("migrate", () => {
  it("creates every collection with its validator and indexes", async () => {
    const report = await migrate(t.db, t.client, { migrationsDir: emptyMigrations });
    expect(report.collectionsCreated.sort()).toEqual(reportedCollections);

    const infos = await t.db.listCollections().toArray();
    for (const def of allCollections) {
      const info = infos.find((i) => i.name === def.name) as { options: Record<string, unknown> } | undefined;
      expect(info, def.name).toBeDefined();
      expect(info!.options.validator).toEqual({ $jsonSchema: toBsonSchema(def.schema) });
      expect(info!.options.validationLevel).toBe("strict");
      expect(info!.options.validationAction).toBe("error");

      const names = (await t.db.collection(def.name).listIndexes().toArray()).map((i) => i.name);
      for (const idx of def.indexes) expect(names, `${def.name}.${idx.name}`).toContain(idx.name);
    }
  });

  it("is idempotent", async () => {
    await migrate(t.db, t.client, { migrationsDir: emptyMigrations });
    const second = await migrate(t.db, t.client, { migrationsDir: emptyMigrations });
    expect(second).toEqual({
      collectionsCreated: [], indexesCreated: [], indexesRecreated: [], unmanagedIndexes: [], migrationsApplied: [],
    });
  });

  it("survives concurrent starts (several containers booting at once)", async () => {
    const reports = await Promise.all([1, 2, 3].map(() => migrate(t.db, t.client, { migrationsDir: emptyMigrations })));
    const created = reports.flatMap((r) => r.collectionsCreated);
    expect(created.sort()).toEqual(reportedCollections);
  });

  it("recreates a changed index and reports, but keeps, unmanaged ones", async () => {
    const v1 = defineCollection({
      name: "widgets",
      schema: z.strictObject({ _id: z.string(), sku: z.string() }),
      indexes: [{ name: "sku", key: { sku: 1 } }],
    });
    await migrate(t.db, t.client, { collections: [v1], migrationsDir: emptyMigrations });
    await t.db.collection("widgets").createIndex({ _id: 1, sku: 1 }, { name: "manual" });

    const v2 = { ...v1, indexes: [{ name: "sku", key: { sku: 1 }, unique: true }] };
    const report = await migrate(t.db, t.client, { collections: [v2], migrationsDir: emptyMigrations });
    expect(report.indexesRecreated).toEqual(["widgets.sku"]);
    expect(report.unmanagedIndexes).toEqual(["widgets.manual"]);

    const sku = (await t.db.collection("widgets").listIndexes().toArray()).find((i) => i.name === "sku");
    expect(sku?.unique).toBe(true);
  });

  it("applies each data migration exactly once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "og-migrations-"));
    await writeFile(
      path.join(dir, "20260922000000-seed_owner.js"),
      `export async function up(db) {
         const now = new Date();
         await db.collection("owners").insertOne({
           _id: "own_01J8Z3K4M5N6P7Q8R9S0T1V2W3", email: "seed@example.com", displayName: null,
           settings: { requireInviteApproval: false, emailOnRecord: true },
           status: "active", createdAt: now, updatedAt: now, lastLoginAt: null,
         });
       }
       export async function down(db) { await db.collection("owners").deleteMany({}); }`,
    );
    const first = await migrate(t.db, t.client, { migrationsDir: dir });
    const second = await migrate(t.db, t.client, { migrationsDir: dir });
    expect(first.migrationsApplied).toEqual(["20260922000000-seed_owner.js"]);
    expect(second.migrationsApplied).toEqual([]);
    expect(await t.db.collection("owners").countDocuments()).toBe(1);
    expect(await t.db.collection("changelog").countDocuments()).toBe(1);
  });
});

describe("validators", () => {
  beforeEach(async () => {
    await migrate(t.db, t.client, { migrationsDir: emptyMigrations });
  });

  it("has a fixture for every collection", () => {
    expect(Object.keys(validDocs).sort()).toEqual(allCollections.map((c) => c.name).sort());
  });

  it.each(allCollections.map((c) => [c.name, c] as const))("%s accepts a valid document (Zod and MongoDB agree)", async (name, def) => {
    const doc = validDocs[name]!;
    expect(def.schema.safeParse(doc).success).toBe(true);
    await t.db.collection(name).deleteMany({}); // migration_lock is empty after migrate, others are fresh
    await expect(t.db.collection(name).insertOne({ ...doc })).resolves.toBeTruthy();
  });

  it.each(invalidDocs)("%s rejects %s (Zod and MongoDB agree)", async (name, _why, doc) => {
    const def = allCollections.find((c) => c.name === name)!;
    expect(def.schema.safeParse(doc).success).toBe(false);
    await expect(t.db.collection(name).insertOne({ ...doc })).rejects.toMatchObject({ code: 121 });
  });
});
