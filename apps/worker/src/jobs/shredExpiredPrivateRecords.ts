import { records, shredContent, type RecordDoc } from "@openglass/db";
import type { Db } from "mongodb";

/**
 * Realignment R1 (docs/SPEC.md §13.3): the retention side of `visibility: "private"` —
 * finds records whose owner-chosen (or platform-default) retention window has passed and
 * crypto-shreds them (`shredContent`, the append-only exception in
 * packages/db/src/repositories/records.ts). Shredding never touches S3 or the signed
 * statement — only clears the wrapped data-key ciphertext — so this job is safe to run
 * repeatedly and out of order with everything else in the sweep loop; a record already
 * shredded (by a prior tick, or by an owner's `owner_deleted` request elsewhere) is simply
 * excluded by the `shreddable_expiresAt` partial index's `encryption.shredded: false`.
 */
export async function shredExpiredPrivateRecords(deps: {
  db: Db;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<{ shredded: number }> {
  const log = deps.log ?? (() => {});
  const now = new Date();
  const due = await deps.db
    .collection<RecordDoc>(records.name)
    .find({ visibility: "private", "encryption.shredded": false, "retention.expiresAt": { $lte: now } })
    .toArray();

  let shredded = 0;
  for (const record of due) {
    const ok = await shredContent(deps.db, record._id, "retention_expired");
    if (ok) {
      shredded++;
    } else {
      log("failed to shred expired private record", { recordId: record._id });
    }
  }
  return { shredded };
}
