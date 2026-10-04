import type { ClientSession, Db } from "mongodb";
import { fetchWitnesses, type FetchWitnessDoc } from "../models/collections.js";

/**
 * `fetch_witnesses` is append-only (SPEC §3, CLAUDE.md): this module exports ONLY
 * insert/find functions, the same rule `repositories/messages.ts` follows.
 */

export async function insertFetchWitness(db: Db, doc: FetchWitnessDoc, opts?: { session?: ClientSession }): Promise<FetchWitnessDoc> {
  await db.collection<FetchWitnessDoc>(fetchWitnesses.name).insertOne(doc, { session: opts?.session });
  return doc;
}

export function findFetchWitnessesByAttestation(db: Db, attestationId: string): Promise<FetchWitnessDoc[]> {
  return db.collection<FetchWitnessDoc>(fetchWitnesses.name).find({ attestationId }).sort({ seq: 1 }).toArray();
}
