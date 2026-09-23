import { invitesRepository, sessionsRepository } from "@openglass/db";
import type { Db } from "mongodb";

/**
 * SPEC §5.2/§5.4: past-expiry sessions are handled differently by status —
 * - `pending` (never accepted in time): session + its invite both become `expired`.
 * - `active` (idle past the session's own expiresAt): moves to `closing` with reason
 *   `idle_timeout`, same as an agent-initiated close but with no agent signature.
 */
export async function closeExpiredSessions(db: Db, now = new Date()): Promise<{ expired: number; idleClosed: number }> {
  const sessions = sessionsRepository(db);
  const invites = invitesRepository(db);
  const expirable = await sessions.findExpirable(now);

  let expired = 0;
  let idleClosed = 0;
  for (const session of expirable) {
    if (session.status === "pending") {
      await sessions.update(session._id, { status: "expired" });
      await invites.update(session.inviteId, { status: "expired", respondedAt: now });
      expired++;
    } else if (session.status === "active") {
      await sessions.update(session._id, {
        status: "closing",
        closing: { reason: "idle_timeout", requestedBy: null, statement: null, signature: null, requestedAt: now },
      });
      idleClosed++;
    }
  }
  return { expired, idleClosed };
}
