import { attestationsRepository } from "@openglass/db";
import type { Db } from "mongodb";

/**
 * The one-party counterpart to `closeExpiredSessions` — simpler, since an attestation has
 * no `pending` state to also handle (it activates immediately on open, no counterparty to
 * wait on). `findExpirable` already only returns `status: "active"` attestations past
 * their own `expiresAt`.
 */
export async function closeExpiredAttestations(db: Db, now = new Date()): Promise<{ idleClosed: number }> {
  const attestations = attestationsRepository(db);
  const expirable = await attestations.findExpirable(now);

  let idleClosed = 0;
  for (const attestation of expirable) {
    await attestations.update(attestation._id, {
      status: "closing",
      closing: { reason: "idle_timeout", requestedBy: null, statement: null, signature: null, requestedAt: now },
    });
    idleClosed++;
  }
  return { idleClosed };
}
