import { agentsRepository, invitesRepository, sessionsRepository } from "@openglass/db";
import type { Db } from "mongodb";

/**
 * SPEC §5.4: "sessions of suspended agents" are worker-closed. `POST
 * /v1/owner/agents/{id}/suspend` already does this synchronously for immediate UX — this
 * job is an idempotent defensive backstop for anything that slips past that (e.g. a crash
 * between the agent update and the session sweep). It only ever does something if the
 * synchronous path was somehow skipped.
 */
export async function closeSuspendedAgentSessions(db: Db, now = new Date()): Promise<{ closed: number; cancelled: number }> {
  const agents = agentsRepository(db);
  const sessions = sessionsRepository(db);
  const invites = invitesRepository(db);

  const suspended = await agents.collection.find({ status: "suspended" }).toArray();
  let closed = 0;
  let cancelled = 0;
  for (const agent of suspended) {
    const affected = await sessions.findActiveOrPendingByAgent(agent._id);
    for (const session of affected) {
      if (session.status === "active") {
        await sessions.update(session._id, {
          status: "closing",
          closing: { reason: "agent_suspended", requestedBy: null, statement: null, signature: null, requestedAt: now },
        });
        closed++;
      } else if (session.status === "pending") {
        await sessions.update(session._id, { status: "cancelled" });
        await invites.update(session.inviteId, { status: "cancelled", respondedAt: now });
        cancelled++;
      }
    }
  }
  return { closed, cancelled };
}
