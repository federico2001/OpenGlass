import type { Db } from "mongodb";
import { agents, type AgentDoc } from "../models/collections.js";

export function agentsRepository(db: Db) {
  const col = db.collection<AgentDoc>(agents.name);
  return {
    collection: col,
    findById: (id: string) => col.findOne({ _id: id }),
    findByPublicKey: (publicKey: string) => col.findOne({ "keys.publicKey": publicKey }),
    findByClaimTokenHash: (tokenHash: string) => col.findOne({ "claim.tokenHash": tokenHash }),
    async insert(doc: AgentDoc) {
      await col.insertOne(doc);
      return doc;
    },
    update: (id: string, patch: Partial<Omit<AgentDoc, "_id" | "createdAt">>) =>
      col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" }),
    listByOwner: (ownerId: string, opts: { limit: number; cursor?: string }) =>
      col
        .find({ ownerId, ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
    findUnclaimedOlderThan: (cutoff: Date) => col.find({ status: "unclaimed", createdAt: { $lt: cutoff } }).toArray(),
    async deleteById(id: string) {
      await col.deleteOne({ _id: id });
    },
  };
}

export type AgentsRepository = ReturnType<typeof agentsRepository>;
