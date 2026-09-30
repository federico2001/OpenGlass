import { approveUnseal, disputeRecord, findRecordById, requestUnseal, type RecordDoc } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { notifyDisputeRaised } from "../domain/alerts.js";
import { sendError } from "../errors.js";
import { verifyOwnerSession } from "../plugins/ownerAuth.js";
import type { ServerDeps } from "../server.js";

/** Owner-only view of a record's unseal/dispute state (docs/SPEC.md §13.2) — mirrors just
 * the `sealedState`/`dispute` shape, not the full record view records.ts's `recordView` returns. */
function sealedStateView(doc: RecordDoc) {
  const s = doc.sealedState;
  return {
    visibility: doc.visibility ?? null,
    dispute: doc.dispute
      ? { disputedBy: doc.dispute.disputedBy, disputedAt: doc.dispute.disputedAt.toISOString() }
      : null,
    sealedState: s
      ? {
          status: s.status,
          requestedBy: s.requestedBy,
          approvals: s.approvals,
          unsealedAt: s.unsealedAt?.toISOString() ?? null,
          disputedBy: s.disputedBy,
          disputedAt: s.disputedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/**
 * Docs/SPEC.md §13.2: disputes, plus the mutual-consent-to-unseal ceremony that legacy
 * `visibility: "sealed"` records keep (sealed is deprecated for new records). A dispute is
 * a flag any participant owner can raise on any record; on a legacy sealed record that
 * isn't unsealed yet it also force-unseals, the rule that record was issued under. Owner-authenticated (not agent-authenticated) — this is a human decision on
 * behalf of a participant, not something an agent can trigger for itself. Every route is
 * scoped to a participant owner of the record; anyone else gets 404, same as the rest of
 * the records surface (canAccessRecord's own convention — never confirm a resource exists
 * to a non-participant).
 */
export function registerSealingRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const ownerAuth = verifyOwnerSession(deps.db, { webOrigin: deps.webOrigin });

  app.post<{ Params: { recordId: string } }>(
    "/v1/records/:recordId/unseal-request",
    { preHandler: ownerAuth },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !record.participantOwnerIds.includes(req.owner!._id)) {
        return sendError(reply, 404, "not_found", "Record not found");
      }
      if (record.visibility !== "sealed") return sendError(reply, 409, "not_sealed", "This record is not visibility: sealed");
      const updated = await requestUnseal(deps.db, record._id, req.owner!._id);
      if (!updated) return sendError(reply, 409, "unseal_already_in_progress", "An unseal request is already in progress or resolved");
      return sealedStateView(updated);
    },
  );

  app.post<{ Params: { recordId: string } }>(
    "/v1/records/:recordId/unseal-approve",
    { preHandler: ownerAuth },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !record.participantOwnerIds.includes(req.owner!._id)) {
        return sendError(reply, 404, "not_found", "Record not found");
      }
      if (record.sealedState?.status !== "unseal_requested") {
        return sendError(reply, 409, "no_pending_unseal_request", "There is no pending unseal request to approve");
      }
      const updated = await approveUnseal(deps.db, record._id, req.owner!._id);
      if (!updated) return sendError(reply, 409, "no_pending_unseal_request", "There is no pending unseal request to approve");
      return sealedStateView(updated);
    },
  );

  app.post<{ Params: { recordId: string } }>("/v1/records/:recordId/dispute", { preHandler: ownerAuth }, async (req, reply) => {
    const record = await findRecordById(deps.db, req.params.recordId);
    if (!record || !record.participantOwnerIds.includes(req.owner!._id)) {
      return sendError(reply, 404, "not_found", "Record not found");
    }
    // A dispute is between the two sides of a session; a one-party attestation has no other side.
    if (record.participantOwnerIds.length < 2) {
      return sendError(reply, 409, "not_disputable", "Only a two-party session record can be disputed");
    }
    const updated = await disputeRecord(deps.db, record._id, req.owner!._id);
    if (!updated) return sendError(reply, 409, "already_disputed", "This record has already been disputed");
    const forceUnsealed = record.sealedState?.status !== "disputed" && updated.sealedState?.status === "disputed";
    notifyDisputeRaised(deps.db, deps.mailer, req.log, record._id, record.participantOwnerIds, req.owner!._id, deps.publicUrl, forceUnsealed).catch((err) =>
      req.log.warn({ err }, "failed to run dispute oversight alert check"),
    );
    return sealedStateView(updated);
  });
}
