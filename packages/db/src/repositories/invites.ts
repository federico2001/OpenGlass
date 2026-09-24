import type { Db } from "mongodb";
import { invites, type InviteDoc } from "../models/collections.js";

export function invitesRepository(db: Db) {
  const col = db.collection<InviteDoc>(invites.name);
  return {
    collection: col,
    findById: (id: string) => col.findOne({ _id: id }),
    findBySessionId: (sessionId: string) => col.findOne({ sessionId }),
    findByTokenHash: (tokenHash: string) => col.findOne({ tokenHash }),
    async insert(doc: InviteDoc) {
      await col.insertOne(doc);
      return doc;
    },
    update: (id: string, patch: Partial<Omit<InviteDoc, "_id" | "createdAt">>) =>
      col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: "after" }),
    listForAgent: (toAgentId: string, opts: { limit: number; cursor?: string; status?: InviteDoc["status"] }) =>
      col
        .find({ toAgentId, ...(opts.status ? { status: opts.status } : {}), ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
    listAwaitingOwnerApproval: (ownerId: string, opts: { limit: number; cursor?: string }) =>
      col
        .find({ status: "awaiting_owner", "ownerApproval.required": true, ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
    findExpirable: (now: Date) => col.find({ status: { $in: ["pending", "awaiting_owner"] }, expiresAt: { $lt: now } }).toArray(),
  };
}

export type InvitesRepository = ReturnType<typeof invitesRepository>;
