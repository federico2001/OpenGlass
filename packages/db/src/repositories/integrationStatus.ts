import type { Db } from "mongodb";
import { integrationStatusOverrides, type IntegrationStatusOverrideDoc } from "../models/collections.js";

export function integrationStatusRepository(db: Db) {
  const col = db.collection<IntegrationStatusOverrideDoc>(integrationStatusOverrides.name);
  return {
    collection: col,
    findBySlug: (slug: string) => col.findOne({ _id: slug }),
    findAll: () => col.find({}).toArray(),
    upsert: (slug: string, status: IntegrationStatusOverrideDoc["status"], updatedBy: string) =>
      col.findOneAndUpdate({ _id: slug }, { $set: { status, updatedAt: new Date(), updatedBy } }, { upsert: true, returnDocument: "after" }),
  };
}

export type IntegrationStatusRepository = ReturnType<typeof integrationStatusRepository>;
