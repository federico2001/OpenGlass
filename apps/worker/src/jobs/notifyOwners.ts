import { ownersRepository, type RecordDoc } from "@openglass/db";
import type { Db } from "mongodb";
import type { Mailer } from "../mailer.js";

/** SPEC §5.4 step 6: emails each owner that has `emailOnRecord` a link to the record. */
export async function emailRecordIssuedOwners(
  db: Db,
  mailer: Mailer,
  record: RecordDoc,
  publicUrl: string,
  log: (message: string, meta?: Record<string, unknown>) => void = () => {},
): Promise<void> {
  const owners = ownersRepository(db);
  const url = `${publicUrl}/records/${record._id}`;
  for (const ownerId of new Set(record.participantOwnerIds)) {
    const owner = await owners.findById(ownerId);
    if (owner?.settings.emailOnRecord) {
      await mailer.sendRecordIssued(owner.email, url).catch((err) => log("failed to email record-issued notice", { ownerId, err }));
    }
  }
}
