import type { InviteDoc, SessionDoc } from "@openglass/db";

/** `Session` (SPEC §8.2 API view). */
export function sessionView(doc: SessionDoc) {
  return {
    id: doc._id,
    mode: doc.mode,
    status: doc.status,
    purpose: doc.purpose,
    initiator: doc.initiator,
    counterparty: doc.counterparty,
    inviteId: doc.inviteId,
    offer: doc.offer,
    offerSignature: doc.offerSignature,
    accept: doc.accept,
    acceptSignature: doc.acceptSignature,
    genesisHash: doc.genesisHash,
    genesisSignature: doc.genesisSignature,
    head: doc.head,
    messageCount: doc.messageCount,
    idleTimeoutSec: doc.idleTimeoutSec,
    createdAt: doc.createdAt.toISOString(),
    activatedAt: doc.activatedAt?.toISOString() ?? null,
    lastActivityAt: doc.lastActivityAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
    pause: doc.pause
      ? { requestedBy: doc.pause.requestedBy, reason: doc.pause.reason, requestedAt: doc.pause.requestedAt.toISOString() }
      : null,
    closing: doc.closing
      ? {
          reason: doc.closing.reason,
          requestedBy: doc.closing.requestedBy,
          statement: doc.closing.statement,
          signature: doc.closing.signature,
          requestedAt: doc.closing.requestedAt.toISOString(),
        }
      : null,
    closedAt: doc.closedAt?.toISOString() ?? null,
    recordId: doc.recordId,
  };
}

/** `Invite` (SPEC §8.2). `token`/`url` are attached separately, only once, right after an
 * open invite is created — this view never re-exposes them on later reads. */
export function inviteView(doc: InviteDoc) {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    fromAgentId: doc.fromAgentId,
    kind: doc.kind,
    toAgentId: doc.toAgentId,
    status: doc.status,
    ownerApproval: doc.ownerApproval
      ? {
          required: doc.ownerApproval.required,
          decision: doc.ownerApproval.decision,
          decidedBy: doc.ownerApproval.decidedBy,
          decidedAt: doc.ownerApproval.decidedAt?.toISOString() ?? null,
        }
      : null,
    expiresAt: doc.expiresAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    respondedAt: doc.respondedAt?.toISOString() ?? null,
  };
}
