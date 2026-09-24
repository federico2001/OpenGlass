import type { Db } from "mongodb";
import { owners, type OwnerDoc } from "../models/collections.js";

export function ownersRepository(db: Db) {
  const col = db.collection<OwnerDoc>(owners.name);
  return {
    collection: col,
    findById: (id: string) => col.findOne({ _id: id }),
    findByEmail: (email: string) => col.findOne({ email }),
    async insert(doc: OwnerDoc) {
      await col.insertOne(doc);
      return doc;
    },
    update: (id: string, patch: Partial<Omit<OwnerDoc, "_id" | "createdAt">>) =>
      col.findOneAndUpdate({ _id: id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: "after" }),
  };
}

export type OwnersRepository = ReturnType<typeof ownersRepository>;
