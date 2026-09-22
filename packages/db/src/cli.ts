#!/usr/bin/env node
import { config as migrateMongoConfig, create } from "migrate-mongo";
import { connectFromEnv } from "./client.js";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.js";

const [command, ...rest] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "migrate": {
      const conn = await connectFromEnv("openglass-migrate");
      try {
        const report = await migrate(conn.db, conn.client, { log: (m) => console.log(m) });
        console.log(JSON.stringify(report, null, 2));
      } finally {
        await conn.close();
      }
      return;
    }
    case "create": {
      const description = rest.join("_");
      if (!description) throw new Error("usage: openglass-migrate create <description>");
      migrateMongoConfig.set({
        mongodb: { url: "unused://", databaseName: "unused", options: {} },
        migrationsDir: DEFAULT_MIGRATIONS_DIR,
        changelogCollectionName: "changelog",
        migrationFileExtension: ".js",
        moduleSystem: "esm",
      });
      console.log(`created migrations/${await create(description)}`);
      return;
    }
    default:
      console.error("usage: openglass-migrate <migrate|create <description>>");
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
