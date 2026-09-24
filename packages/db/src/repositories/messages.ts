import type { ClientSession, Db } from "mongodb";
import { messages, type MessageDoc } from "../models/collections.js";

/**
 * `messages` is append-only (SPEC §3, CLAUDE.md): this module exports ONLY insert/find
 * functions. `test/repositories/appendOnly.test.ts` asserts this export list doesn't grow
 * an update/delete — never add one here.
 */

export async function insertMessage(db: Db, doc: MessageDoc, opts?: { session?: ClientSession }): Promise<MessageDoc> {
  await db.collection<MessageDoc>(messages.name).insertOne(doc, { session: opts?.session });
  return doc;
}

export function findMessagesBySession(
  db: Db,
  sessionId: string,
  opts: { afterSeq: number; limit: number },
): Promise<MessageDoc[]> {
  return db
    .collection<MessageDoc>(messages.name)
    .find({ sessionId, seq: { $gt: opts.afterSeq } })
    .sort({ seq: 1 })
    .limit(opts.limit)
    .toArray();
}

export function findAllMessagesBySession(db: Db, sessionId: string): Promise<MessageDoc[]> {
  return db.collection<MessageDoc>(messages.name).find({ sessionId }).sort({ seq: 1 }).toArray();
}

export function findMessageByHash(db: Db, sessionId: string, hash: string): Promise<MessageDoc | null> {
  return db.collection<MessageDoc>(messages.name).findOne({ sessionId, hash });
}
