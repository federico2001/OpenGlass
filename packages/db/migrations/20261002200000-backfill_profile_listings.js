/**
 * docs/SPEC.md §16: `profile_listings` records every agent that listed a domain as an
 * unclaimed profile. Profiles listed before it existed only kept their first lister
 * (`unclaimed_profiles.listedBy`), so this adds that one listing for each of them. Only
 * inserts missing rows, so it's safe to run more than once, and never touches the profiles.
 *
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
export const up = async (db, client) => {
  const cursor = db.collection("unclaimed_profiles").find({}, { projection: { _id: 1, listedBy: 1, listedAt: 1, lastSeenAt: 1 } });
  for await (const profile of cursor) {
    await db.collection("profile_listings").updateOne(
      { _id: `${profile.listedBy}|${profile._id}` },
      { $setOnInsert: { agentId: profile.listedBy, domain: profile._id, firstListedAt: profile.listedAt, lastListedAt: profile.lastSeenAt } },
      { upsert: true },
    );
  }
};

/**
 * Leaves `profile_listings` in place: rows written after this migration can't be told apart
 * from backfilled ones, and the collection is harmless to keep.
 *
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
export const down = async (db, client) => {};
