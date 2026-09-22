import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { connect, type Connection } from "../src/client.js";

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** Same URI as the suite, pointed at a fresh database so test files can't interfere. */
export function uniqueDbUri(): string {
  const uri = inject("mongoUri");
  const name = `og_test_${randomBytes(6).toString("hex")}`;
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/[^?]*/, `$1/${name}`);
}

/**
 * Opens a connection to a unique test database. `cleanup` drops its collections
 * one by one (dropDatabase needs a privilege Atlas app users usually don't have).
 */
export async function openTestDb(): Promise<Connection & { uri: string; cleanup: () => Promise<void> }> {
  const uri = uniqueDbUri();
  const conn = await connect(uri, "openglass-test");
  return {
    ...conn,
    uri,
    cleanup: async () => {
      for (const c of await conn.db.listCollections({}, { nameOnly: true }).toArray()) {
        await conn.db.dropCollection(c.name);
      }
      await conn.close();
    },
  };
}
