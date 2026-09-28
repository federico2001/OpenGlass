import type { Db } from "mongodb";
import { newId } from "../ids.js";
import { viewerAccessLog, type ViewerAccessLogDoc } from "../models/collections.js";

export function viewerAccessLogRepository(db: Db) {
  const col = db.collection<ViewerAccessLogDoc>(viewerAccessLog.name);
  return {
    collection: col,
    /** Fire-and-forget by design at call sites (see routes/owner.ts) — a read a viewer
     * makes should never fail or slow down because the audit write had trouble. */
    record: (entry: Omit<ViewerAccessLogDoc, "_id" | "at">) => col.insertOne({ ...entry, _id: newId("val"), at: new Date() }),
    /** Scoped to one agent, matching the route it backs (`GET
     * /v1/owner/agents/{agentId}/access-log`) — `ownerId` alone would need client-side
     * filtering per agent afterward, which breaks cursor pagination once an owner has more
     * than one agent with any grants. */
    listForAgent: (ownerId: string, agentId: string, opts: { limit: number; cursor?: string }) =>
      col
        .find({ ownerId, agentId, ...(opts.cursor ? { _id: { $lt: opts.cursor } } : {}) })
        .sort({ at: -1, _id: -1 })
        .limit(opts.limit)
        .toArray(),
  };
}

export type ViewerAccessLogRepository = ReturnType<typeof viewerAccessLogRepository>;
