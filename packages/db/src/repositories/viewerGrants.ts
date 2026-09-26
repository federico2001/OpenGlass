import type { Db } from "mongodb";
import { viewerGrants, type ViewerGrantDoc } from "../models/collections.js";

export function viewerGrantsRepository(db: Db) {
  const col = db.collection<ViewerGrantDoc>(viewerGrants.name);
  return {
    collection: col,
    findById: (id: string) => col.findOne({ _id: id }),
    findByAgentAndEmail: (agentId: string, viewerEmail: string) => col.findOne({ agentId, viewerEmail }),
    async insert(doc: ViewerGrantDoc) {
      await col.insertOne(doc);
      return doc;
    },
    update: (id: string, patch: Partial<Omit<ViewerGrantDoc, "_id" | "createdAt">>) =>
      col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: "after" }),
    listForAgent: (agentId: string, opts: { limit: number; cursor?: string }) =>
      col
        .find({ agentId, ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
    /** Every agent a viewer currently has active read access to, by their verified email
     * (SPEC §4.2 — viewers sign in the same passwordless way owners do). */
    listActiveForViewer: (viewerEmail: string) => col.find({ viewerEmail, status: "active" }).toArray(),
  };
}

export type ViewerGrantsRepository = ReturnType<typeof viewerGrantsRepository>;
