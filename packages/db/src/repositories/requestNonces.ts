import type { Db, MongoServerError } from "mongodb";
import { requestNonces, type RequestNonceDoc } from "../models/collections.js";
import { DUPLICATE_KEY_ERROR_CODE } from "./records.js";

export function requestNoncesRepository(db: Db) {
  const col = db.collection<RequestNonceDoc>(requestNonces.name);
  return {
    /** Inserts `<agentId>:<nonce>`; returns false (401 nonce_reused) on a duplicate. */
    async claim(agentOrKeyId: string, nonce: string, expiresAt: Date): Promise<boolean> {
      try {
        await col.insertOne({ _id: `${agentOrKeyId}:${nonce}`, expiresAt });
        return true;
      } catch (err) {
        if ((err as MongoServerError).code === DUPLICATE_KEY_ERROR_CODE) return false;
        throw err;
      }
    },
  };
}

export type RequestNoncesRepository = ReturnType<typeof requestNoncesRepository>;
