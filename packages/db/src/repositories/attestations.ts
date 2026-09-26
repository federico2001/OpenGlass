import type { ClientSession, Db } from "mongodb";
import { attestations, type AttestationDoc } from "../models/collections.js";

export function attestationsRepository(db: Db) {
  const col = db.collection<AttestationDoc>(attestations.name);
  return {
    collection: col,
    findById: (id: string) => col.findOne({ _id: id }),
    async insert(doc: AttestationDoc) {
      await col.insertOne(doc);
      return doc;
    },
    update: (id: string, patch: Partial<Omit<AttestationDoc, "_id" | "createdAt">>) =>
      col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: "after" }),
    /** Same conditional-on-head-not-having-moved pattern as sessions.advanceHead. */
    advanceHead: (
      id: string,
      expectedSeq: number,
      patch: { head: { seq: number; hash: string }; eventCount: number; lastActivityAt: Date; expiresAt: Date },
      opts?: { session?: ClientSession },
    ) =>
      col.findOneAndUpdate(
        { _id: id, status: "active", "head.seq": expectedSeq },
        { $set: patch },
        { returnDocument: "after", session: opts?.session },
      ),
    listByAttestor: (
      field: "attestor.agentId" | "attestor.ownerId",
      value: string,
      opts: { limit: number; cursor?: string; status?: AttestationDoc["status"] },
    ) =>
      col
        .find({ [field]: value, ...(opts.status ? { status: opts.status } : {}), ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
    findExpirable: (now: Date) => col.find({ status: "active", expiresAt: { $lt: now } }).toArray(),
    findClosing: () => col.find({ status: "closing" }).toArray(),
  };
}

export type AttestationsRepository = ReturnType<typeof attestationsRepository>;
