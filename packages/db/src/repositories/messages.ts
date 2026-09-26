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

/** Prompt 13 (public live feed): recent messages across a set of eligible sessions, newest
 * `opts.limit` first when `opts.after` is unset, or the next page after it (oldest first)
 * when polling. `sessionIds` is caller-filtered (e.g. to publicFeedOptIn sessions only) —
 * this function has no opinion on which sessions are eligible. */
export async function findRecentMessagesBySessions(
  db: Db,
  sessionIds: string[],
  opts: { after: Date | null; limit: number },
): Promise<MessageDoc[]> {
  const col = db.collection<MessageDoc>(messages.name);
  if (opts.after) {
    return col
      .find({ sessionId: { $in: sessionIds }, receivedAt: { $gt: opts.after } })
      .sort({ receivedAt: 1 })
      .limit(opts.limit)
      .toArray();
  }
  const recent = await col.find({ sessionId: { $in: sessionIds } }).sort({ receivedAt: -1 }).limit(opts.limit).toArray();
  return recent.reverse();
}
