import type { AttestationDoc, RecordDoc, SessionDoc } from "@openglass/db";

export type SessionParticipant = SessionDoc["initiator"];

/** Shared shape of the fields every access check reads off `req`: `agent` and `owner` come
 * from the respective auth plugins; `viewerAgentIds` — the agents a human viewer grant
 * (Prompt 6) currently covers for this owner-authenticated caller, keyed by their verified
 * email — is populated by `verifyOwnerSession` (see plugins/ownerAuth.ts). */
export interface AccessRequest {
  agent?: { doc: { _id: string } };
  owner?: { _id: string };
  viewerAgentIds?: Set<string>;
}

/** Returns the caller's own participant record (initiator or counterparty side) on this
 * session, or null if they're not a participant at all. */
export function participantOf(session: SessionDoc, agentId: string): SessionParticipant | null {
  if (session.initiator.agentId === agentId) return session.initiator;
  if (session.counterparty.agentId === agentId) return session.counterparty;
  return null;
}

/** SPEC §8.1 access rule: a session (and its messages/record) can be read by the two
 * participant agents and their two owners, extended (Prompt 6) to anyone holding an active
 * viewer grant on either participant agent — everyone else gets 404, not 403, so the
 * response never confirms the resource exists. */
export function canAccessSession(session: SessionDoc, req: AccessRequest): boolean {
  if (req.agent && (session.initiator.agentId === req.agent.doc._id || session.counterparty.agentId === req.agent.doc._id)) {
    return true;
  }
  if (req.owner && (session.initiator.ownerId === req.owner._id || session.counterparty.ownerId === req.owner._id)) {
    return true;
  }
  if (req.viewerAgentIds) {
    if (session.initiator.agentId && req.viewerAgentIds.has(session.initiator.agentId)) return true;
    if (session.counterparty.agentId && req.viewerAgentIds.has(session.counterparty.agentId)) return true;
  }
  return false;
}

/** One-party version of `canAccessSession` (Prompt 20) — the attestor agent, its owner,
 * or a viewer grant holder on that one agent. */
export function canAccessAttestation(attestation: AttestationDoc, req: AccessRequest): boolean {
  if (req.agent && attestation.attestor.agentId === req.agent.doc._id) return true;
  if (req.owner && attestation.attestor.ownerId === req.owner._id) return true;
  if (req.viewerAgentIds && req.viewerAgentIds.has(attestation.attestor.agentId)) return true;
  return false;
}

/** Same access rule as `canAccessSession`, for a record — participant agents' owners and
 * their viewer grant holders, in addition to the two participant agents themselves. */
export function canAccessRecord(record: RecordDoc, req: AccessRequest): boolean {
  if (req.agent && record.participantAgentIds.includes(req.agent.doc._id)) return true;
  if (req.owner && record.participantOwnerIds.includes(req.owner._id)) return true;
  if (req.viewerAgentIds && record.participantAgentIds.some((id) => req.viewerAgentIds!.has(id))) return true;
  return false;
}
