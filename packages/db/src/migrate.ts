import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { Db, Document, IndexDescription, MongoClient } from "mongodb";
import { config as migrateMongoConfig, up as migrateMongoUp } from "migrate-mongo";
import { toBsonSchema } from "./jsonSchema.js";
import { allCollections, changelog, migrationLock } from "./models/collections.js";
import type { CollectionDef } from "./models/define.js";

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export interface MigrateOptions {
  collections?: readonly CollectionDef[];
  migrationsDir?: string;
  log?: (msg: string) => void;
  lockTimeoutMs?: number;
}

export interface MigrateReport {
  collectionsCreated: string[];
  indexesCreated: string[];
  indexesRecreated: string[];
  unmanagedIndexes: string[];
  migrationsApplied: string[];
}

/**
 * Idempotent schema step, run on every api start:
 *   1. take the migration lock,
 *   2. create or collMod every collection with its $jsonSchema validator,
 *   3. reconcile indexes (create missing, recreate changed; never drop unknown ones),
 *   4. apply pending data migrations from /packages/db/migrations (migrate-mongo).
 */
export async function migrate(db: Db, client: MongoClient, opts: MigrateOptions = {}): Promise<MigrateReport> {
  const log = opts.log ?? (() => {});
  const collections = opts.collections ?? allCollections;
  const report: MigrateReport = {
    collectionsCreated: [],
    indexesCreated: [],
    indexesRecreated: [],
    unmanagedIndexes: [],
    migrationsApplied: [],
  };

  // Bookkeeping: exists before the lock is taken, so it's never reported as created.
  await ensureCollection(db, migrationLock);
  const release = await acquireLock(db, opts.lockTimeoutMs ?? 120_000, log);
  try {
    const defs = collections.includes(migrationLock) ? collections : [...collections, migrationLock];
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

    for (const def of defs) {
      if (existing.has(def.name)) {
        await db.command({ collMod: def.name, ...validatorOptions(def) });
      } else {
        await ensureCollection(db, def);
        report.collectionsCreated.push(def.name);
      }
      await reconcileIndexes(db, def, report, log);
    }

    report.migrationsApplied = await runDataMigrations(db, client, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    for (const m of report.migrationsApplied) log(`applied migration ${m}`);
  } finally {
    await release();
  }
  return report;
}

const validatorOptions = (def: CollectionDef) =>
  ({ validator: { $jsonSchema: toBsonSchema(def.schema) }, validationLevel: "strict", validationAction: "error" }) as const;

/** Creates the collection with its validator; a no-op if another process created it first. */
async function ensureCollection(db: Db, def: CollectionDef): Promise<void> {
  try {
    await db.createCollection(def.name, validatorOptions(def));
  } catch (err) {
    if ((err as { code?: number }).code !== 48 /* NamespaceExists */) throw err;
  }
}

async function reconcileIndexes(db: Db, def: CollectionDef, report: MigrateReport, log: (m: string) => void) {
  const coll = db.collection(def.name);
  const current = (await coll.listIndexes().toArray()) as Document[];
  const wanted = new Set(def.indexes.map((i) => i.name));

  for (const index of def.indexes) {
    const byName = current.find((c) => c.name === index.name);
    const byKey = current.find((c) => c.name !== index.name && sameKey(c.key, index.key));
    if (byName && sameIndex(byName, index)) continue;
    if (byName || (byKey && !wanted.has(byKey.name))) {
      const drop = byName ?? byKey!;
      await coll.dropIndex(drop.name);
      report.indexesRecreated.push(`${def.name}.${index.name}`);
      log(`recreating index ${def.name}.${index.name}`);
    } else {
      report.indexesCreated.push(`${def.name}.${index.name}`);
    }
    await coll.createIndexes([index]);
  }

  for (const c of current) {
    if (c.name !== "_id_" && !wanted.has(c.name)) {
      report.unmanagedIndexes.push(`${def.name}.${c.name}`);
      log(`warning: unmanaged index ${def.name}.${c.name} (not dropped)`);
    }
  }
}

const sameKey = (a: Document, b: IndexDescription["key"]) => JSON.stringify(a) === JSON.stringify(b);

function sameIndex(existing: Document, wanted: IndexDescription): boolean {
  return (
    sameKey(existing.key, wanted.key) &&
    Boolean(existing.unique) === Boolean(wanted.unique) &&
    JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(wanted.partialFilterExpression ?? null) &&
    (existing.expireAfterSeconds ?? null) === (wanted.expireAfterSeconds ?? null)
  );
}

async function acquireLock(db: Db, timeoutMs: number, log: (m: string) => void): Promise<() => Promise<void>> {
  const locks = db.collection<{ _id: "migrate"; holder: string; expiresAt: Date }>(migrationLock.name);
  const holder = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let waiting = false;
  for (;;) {
    // Clear a stale lock left by a crashed container (TTL cleanup can lag by ~60s).
    await locks.deleteOne({ _id: "migrate", expiresAt: { $lt: new Date() } });
    try {
      await locks.insertOne({ _id: "migrate", holder, expiresAt: new Date(Date.now() + 5 * 60_000) });
      return async () => {
        await locks.deleteOne({ _id: "migrate", holder });
      };
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      if (Date.now() > deadline) throw new Error("Timed out waiting for the migration lock");
      if (!waiting) log("waiting for migration lock held by another process");
      waiting = true;
      await sleep(1000);
    }
  }
}

async function runDataMigrations(db: Db, client: MongoClient, migrationsDir: string): Promise<string[]> {
  migrateMongoConfig.set({
    mongodb: { url: "unused://", databaseName: db.databaseName, options: {} },
    migrationsDir,
    changelogCollectionName: changelog.name,
    // Locking is handled by acquireLock above; migrate-mongo's own lock is racy.
    lockCollectionName: "",
    lockTtl: 0,
    migrationFileExtension: ".js",
    useFileHash: false,
    moduleSystem: "esm",
  });
  return migrateMongoUp(db, client);
}
