import type { SessionDoc } from "@openglass/db";

export type SessionParticipant = SessionDoc["initiator"];

/** Returns the caller's own participant record (initiator or counterparty side) on this
 * session, or null if they're not a participant at all. */
export function participantOf(session: SessionDoc, agentId: string): SessionParticipant | null {
  if (session.initiator.agentId === agentId) return session.initiator;
  if (session.counterparty.agentId === agentId) return session.counterparty;
  return null;
}

/** SPEC §8.1 access rule: a session (and its messages/record) can be read by the two
 * participant agents and their two owners — everyone else gets 404, not 403, so the
 * response never confirms the resource exists. */
export function canAccessSession(
  session: SessionDoc,
  req: { agent?: { doc: { _id: string } }; owner?: { _id: string } },
): boolean {
  if (req.agent && (session.initiator.agentId === req.agent.doc._id || session.counterparty.agentId === req.agent.doc._id)) {
    return true;
  }
  if (req.owner && (session.initiator.ownerId === req.owner._id || session.counterparty.ownerId === req.owner._id)) {
    return true;
  }
  return false;
}
