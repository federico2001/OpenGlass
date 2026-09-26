import type { Db } from "mongodb";
import { integrationRequests, type IntegrationRequestDoc } from "../models/collections.js";

export function integrationRequestsRepository(db: Db) {
  const col = db.collection<IntegrationRequestDoc>(integrationRequests.name);
  return {
    collection: col,
    async insert(doc: IntegrationRequestDoc) {
      await col.insertOne(doc);
      return doc;
    },
    findById: (id: string) => col.findOne({ _id: id }),
    list: (opts: { limit: number; cursor?: string; status?: IntegrationRequestDoc["status"] }) =>
      col
        .find({ ...(opts.status ? { status: opts.status } : {}), ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
    update: (id: string, patch: Partial<Omit<IntegrationRequestDoc, "_id" | "createdAt">>) =>
      col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: "after" }),
  };
}

export type IntegrationRequestsRepository = ReturnType<typeof integrationRequestsRepository>;
