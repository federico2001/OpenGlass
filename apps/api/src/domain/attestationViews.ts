import type { AttestationDoc } from "@openglass/db";

/** `Attestation` (Prompt 20 API view) — the one-party counterpart to `sessionView`. */
export function attestationView(doc: AttestationDoc) {
  return {
    id: doc._id,
    mode: doc.mode,
    status: doc.status,
    purpose: doc.purpose,
    attestor: doc.attestor,
    open: doc.open,
    openSignature: doc.openSignature,
    genesisHash: doc.genesisHash,
    genesisSignature: doc.genesisSignature,
    head: doc.head,
    eventCount: doc.eventCount,
    idleTimeoutSec: doc.idleTimeoutSec,
    createdAt: doc.createdAt.toISOString(),
    activatedAt: doc.activatedAt.toISOString(),
    lastActivityAt: doc.lastActivityAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
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
