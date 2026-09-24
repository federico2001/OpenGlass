import type { Db } from "mongodb";
import { loginTokens, type LoginTokenDoc } from "../models/collections.js";

export function loginTokensRepository(db: Db) {
  const col = db.collection<LoginTokenDoc>(loginTokens.name);
  return {
    async insert(doc: LoginTokenDoc) {
      await col.insertOne(doc);
      return doc;
    },
    findAndDelete: async (tokenHash: string) => {
      const doc = await col.findOne({ _id: tokenHash });
      if (doc) await col.deleteOne({ _id: tokenHash });
      return doc;
    },
  };
}

export type LoginTokensRepository = ReturnType<typeof loginTokensRepository>;
