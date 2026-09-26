import type { Db } from "mongodb";
import { integrationVotes, type IntegrationVoteDoc } from "../models/collections.js";

export function integrationVotesRepository(db: Db) {
  const col = db.collection<IntegrationVoteDoc>(integrationVotes.name);
  return {
    collection: col,
    findBySlugAndOwner: (slug: string, ownerId: string) => col.findOne({ slug, ownerId }),
    async insert(doc: IntegrationVoteDoc) {
      await col.insertOne(doc);
      return doc;
    },
    deleteBySlugAndOwner: (slug: string, ownerId: string) => col.deleteOne({ slug, ownerId }),
    async countsBySlug(slugs: string[]): Promise<Record<string, number>> {
      const rows = await col
        .aggregate<{ _id: string; count: number }>([{ $match: { slug: { $in: slugs } } }, { $group: { _id: "$slug", count: { $sum: 1 } } }])
        .toArray();
      return Object.fromEntries(rows.map((r) => [r._id, r.count]));
    },
    async votedSlugsForOwner(ownerId: string): Promise<Set<string>> {
      const rows = await col.find({ ownerId }).project<{ slug: string }>({ slug: 1 }).toArray();
      return new Set(rows.map((r) => r.slug));
    },
  };
}

export type IntegrationVotesRepository = ReturnType<typeof integrationVotesRepository>;
