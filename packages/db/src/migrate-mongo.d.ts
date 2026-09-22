declare module "migrate-mongo" {
  import type { Db, MongoClient } from "mongodb";
  export const config: { set(content: Record<string, unknown>): void };
  export function up(db: Db, client: MongoClient): Promise<string[]>;
  export function create(description: string): Promise<string>;
}
