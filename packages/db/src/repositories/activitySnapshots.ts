import type { Db } from "mongodb";
import { activitySnapshots, type ActivitySnapshotDoc } from "../models/collections.js";

export function activitySnapshotsRepository(db: Db) {
  const col = db.collection<ActivitySnapshotDoc>(activitySnapshots.name);
  return {
    findById: (date: string) => col.findOne({ _id: date }),
    async insert(doc: ActivitySnapshotDoc) {
      await col.insertOne(doc);
      return doc;
    },
    listRecent: (limit: number) => col.find({}).sort({ _id: -1 }).limit(limit).toArray(),
  };
}

export type ActivitySnapshotsRepository = ReturnType<typeof activitySnapshotsRepository>;
