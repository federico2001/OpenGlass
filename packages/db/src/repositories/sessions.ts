import type { ClientSession, Db } from "mongodb";
import { sessions, type SessionDoc } from "../models/collections.js";

export function sessionsRepository(db: Db) {
  const col = db.collection<SessionDoc>(sessions.name);
  return {
    collection: col,
    findById: (id: string) => col.findOne({ _id: id }),
    findByInviteId: (inviteId: string) => col.findOne({ inviteId }),
    async insert(doc: SessionDoc) {
      await col.insertOne(doc);
      return doc;
    },
    update: (id: string, patch: Partial<Omit<SessionDoc, "_id" | "createdAt">>) =>
      col.findOneAndUpdate({ _id: id }, { $set: patch }, { returnDocument: "after" }),
    /** Only a message append or a close may change `head`; conditional on the head not
     * having moved since the caller read it (SPEC §5.3 step 4-5, §3.3). */
    advanceHead: (
      id: string,
      expectedSeq: number,
      patch: { head: { seq: number; hash: string }; messageCount: number; lastActivityAt: Date; expiresAt: Date },
      opts?: { session?: ClientSession },
    ) =>
      col.findOneAndUpdate(
        { _id: id, status: "active", "head.seq": expectedSeq },
        { $set: patch },
        { returnDocument: "after", session: opts?.session },
      ),
    listByParticipant: (
      field: "initiator.agentId" | "counterparty.agentId" | "initiator.ownerId" | "counterparty.ownerId",
      value: string,
      opts: { limit: number; cursor?: string; status?: SessionDoc["status"] },
    ) =>
      col
        .find({ [field]: value, ...(opts.status ? { status: opts.status } : {}), ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
    countPendingByInitiator: (agentId: string) => col.countDocuments({ "initiator.agentId": agentId, status: "pending" }),
    findExpirable: (now: Date) => col.find({ status: { $in: ["pending", "active"] }, expiresAt: { $lt: now } }).toArray(),
    findActiveOrPendingByAgent: (agentId: string) =>
      col
        .find({
          status: { $in: ["pending", "active"] },
          $or: [{ "initiator.agentId": agentId }, { "counterparty.agentId": agentId }],
        })
        .toArray(),
    findClosing: () => col.find({ status: "closing" }).toArray(),
  };
}

export type SessionsRepository = ReturnType<typeof sessionsRepository>;
