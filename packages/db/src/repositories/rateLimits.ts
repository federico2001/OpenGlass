import type { Db } from "mongodb";
import { rateLimits, type RateLimitDoc } from "../models/collections.js";

export function rateLimitsRepository(db: Db) {
  const col = db.collection<RateLimitDoc>(rateLimits.name);
  return {
    /** Fixed-window increment-and-check (SPEC §10 / D11). Returns the count after
     * incrementing and the window's reset time. */
    async increment(rule: string, key: string, windowMs: number, now: Date): Promise<{ count: number; resetAt: Date }> {
      const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
      const id = `${rule}:${key}:${windowStart}`;
      const resetAt = new Date(windowStart + windowMs);
      const doc = await col.findOneAndUpdate(
        { _id: id },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: resetAt } },
        { upsert: true, returnDocument: "after" },
      );
      return { count: doc!.count, resetAt };
    },
  };
}

export type RateLimitsRepository = ReturnType<typeof rateLimitsRepository>;
