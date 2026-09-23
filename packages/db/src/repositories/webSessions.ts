import type { Db } from "mongodb";
import { webSessions, type WebSessionDoc } from "../models/collections.js";

export function webSessionsRepository(db: Db) {
  const col = db.collection<WebSessionDoc>(webSessions.name);
  return {
    async insert(doc: WebSessionDoc) {
      await col.insertOne(doc);
      return doc;
    },
    findByTokenHash: (tokenHash: string) => col.findOne({ _id: tokenHash }),
    async touch(tokenHash: string, expiresAt: Date) {
      await col.updateOne({ _id: tokenHash }, { $set: { expiresAt } });
    },
    async deleteByTokenHash(tokenHash: string) {
      await col.deleteOne({ _id: tokenHash });
    },
  };
}

export type WebSessionsRepository = ReturnType<typeof webSessionsRepository>;
