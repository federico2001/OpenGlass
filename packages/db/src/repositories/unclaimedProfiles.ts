import type { Db } from "mongodb";
import { unclaimedProfiles, type UnclaimedProfileDoc } from "../models/collections.js";

/** docs/SPEC.md §16. Keyed by bare hostname; `list` is idempotent (a second listing only
 * refreshes `lastSeenAt` and the card facts, never `listedBy`/`listedAt`). */
export function unclaimedProfilesRepository(db: Db) {
  const col = db.collection<UnclaimedProfileDoc>(unclaimedProfiles.name);
  return {
    collection: col,
    findByDomain: (domain: string) => col.findOne({ _id: domain }),
    async list(input: {
      domain: string;
      listedBy: string;
      agentCardUrl: string | null;
      cardSha256: string | null;
      now: Date;
    }): Promise<{ profile: UnclaimedProfileDoc; created: boolean }> {
      const { domain, listedBy, agentCardUrl, cardSha256, now } = input;
      const result = await col.findOneAndUpdate(
        { _id: domain },
        {
          $set: { lastSeenAt: now, agentCardUrl, cardSha256, cardFetchedAt: agentCardUrl ? now : null },
          $setOnInsert: { listedBy, listedAt: now, claimedAgentId: null, claimedAt: null },
        },
        { upsert: true, returnDocument: "after", includeResultMetadata: true },
      );
      return { profile: result.value!, created: !result.lastErrorObject?.updatedExisting };
    },
    /** Marks the profile claimed by the agent that just proved control of the domain. A
     * no-op when there's no profile for the domain or it's already claimed. */
    markClaimed: (domain: string, agentId: string, now: Date) =>
      col.updateOne({ _id: domain, claimedAgentId: null }, { $set: { claimedAgentId: agentId, claimedAt: now } }),
  };
}

export type UnclaimedProfilesRepository = ReturnType<typeof unclaimedProfilesRepository>;
