import { MongoClient, type Db } from "mongodb";

export interface Connection {
  client: MongoClient;
  db: Db;
  close: () => Promise<void>;
}

/** The database name must be part of the URI path (…/openglass?…); it's the only DB config. */
export function databaseNameFromUri(uri: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri);
  const name = match?.[1] ? decodeURIComponent(match[1]) : "";
  if (!name) throw new Error("MONGODB_URI must include a database name, e.g. mongodb://host:27017/openglass");
  return name;
}

export async function connect(uri: string, appName = "openglass"): Promise<Connection> {
  const dbName = databaseNameFromUri(uri);
  const client = new MongoClient(uri, { appName, serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  return { client, db: client.db(dbName), close: () => client.close() };
}

/** Connects using MONGODB_URI. There is deliberately no other way to configure the database. */
export function connectFromEnv(appName?: string): Promise<Connection> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  return connect(uri, appName);
}
