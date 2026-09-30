import { agentsRepository, ownersRepository, sessions as sessionsCollection, type OwnerDoc, type SessionDoc } from "@openglass/db";
import type { Db } from "mongodb";
import type { Mailer } from "../mailer.js";

/**
 * Realignment R4 (docs/SPEC.md §15): the four oversight-alert triggers. Each function is
 * called from the route where the underlying event actually happens (session activation,
 * a high-risk attestation event, a dispute) — this module only decides *whether* to alert
 * and builds the email, never the business logic of the event itself. Every send is
 * best-effort: a mail failure is logged, never surfaced as an error to the caller whose
 * real request (accepting a session, attesting an action, disputing a record) already
 * succeeded by the time an alert would fire.
 */

async function maybeSend(deps: { mailer: Mailer; log: { warn: (obj: unknown, msg: string) => void } }, owner: OwnerDoc | null, send: () => Promise<void>): Promise<void> {
  if (!owner || owner.settings.oversightAlerts === false) return;
  try {
    await send();
  } catch (err) {
    deps.log.warn({ err, ownerId: owner._id }, "failed to send oversight alert email");
  }
}

/** Fires from both places a session can become `active` (invites.ts's direct accept, and
 * owner.ts's approve-after-review) — checks, from each owner's own side, whether the
 * *other* participant is a first-time counterparty and/or has an unverified domain. */
export async function notifyCounterpartyAlerts(
  db: Db,
  mailer: Mailer,
  log: { warn: (obj: unknown, msg: string) => void },
  session: SessionDoc,
  publicUrl: string,
): Promise<void> {
  const initiatorAgentId = session.initiator.agentId;
  const counterpartyAgentId = session.counterparty.agentId;
  const initiatorOwnerId = session.initiator.ownerId;
  const counterpartyOwnerId = session.counterparty.ownerId;
  if (!initiatorAgentId || !counterpartyAgentId || !initiatorOwnerId || !counterpartyOwnerId) return;

  const owners = ownersRepository(db);
  const agents = agentsRepository(db);
  const col = db.collection<SessionDoc>(sessionsCollection.name);

  const sides: { selfOwnerId: string; otherAgentId: string; otherOwnerId: string }[] = [
    { selfOwnerId: initiatorOwnerId, otherAgentId: counterpartyAgentId, otherOwnerId: counterpartyOwnerId },
    { selfOwnerId: counterpartyOwnerId, otherAgentId: initiatorAgentId, otherOwnerId: initiatorOwnerId },
  ];

  for (const side of sides) {
    const [selfOwner, otherAgent] = await Promise.all([owners.findById(side.selfOwnerId), agents.findById(side.otherAgentId)]);
    if (!selfOwner || !otherAgent) continue;

    const priorCount = await col.countDocuments({
      _id: { $ne: session._id },
      status: { $in: ["active", "closing", "closed"] },
      $or: [
        { "initiator.ownerId": side.selfOwnerId, "counterparty.ownerId": side.otherOwnerId },
        { "initiator.ownerId": side.otherOwnerId, "counterparty.ownerId": side.selfOwnerId },
      ],
    });
    const sessionUrl = `${publicUrl}/dashboard/sessions/${session._id}`;

    if (priorCount === 0) {
      await maybeSend({ mailer, log }, selfOwner, () =>
        mailer.sendOversightAlert(selfOwner.email, "new_counterparty", `${otherAgent.name} (${otherAgent._id}) — first session with this counterparty.`, sessionUrl),
      );
    }
    if (otherAgent.domainVerification?.status !== "verified") {
      await maybeSend({ mailer, log }, selfOwner, () =>
        mailer.sendOversightAlert(selfOwner.email, "unverified_counterparty", `${otherAgent.name} (${otherAgent._id}) has no verified domain.`, sessionUrl),
      );
    }
  }
}

/** Fires from POST /v1/attestations/{id}/events when the appended event's payload carries
 * `{verdict: {risk: "high"}}` — the shape `evaluateAndAttest` (core-js/core-py's
 * openglass-policy integration, docs/POLICY.md) writes into a relay-mode attestation
 * event's own payload. Absent for notary-mode events (no payload at all) or any event not
 * created through that integration — this is a best-effort read of an established
 * convention, not a guaranteed signal, so it silently does nothing when the shape isn't
 * there rather than erroring. */
export async function notifyHighRiskAction(
  db: Db,
  mailer: Mailer,
  log: { warn: (obj: unknown, msg: string) => void },
  attestorOwnerId: string,
  attestationId: string,
  payload: unknown,
  publicUrl: string,
): Promise<void> {
  const risk = (payload as { verdict?: { risk?: string; matches?: { id?: string }[] } } | undefined)?.verdict;
  if (risk?.risk !== "high") return;
  const owners = ownersRepository(db);
  const owner = await owners.findById(attestorOwnerId);
  const matchedRules = risk.matches?.map((m) => m.id).filter(Boolean).join(", ") || "no rule ids reported";
  await maybeSend({ mailer, log }, owner, () =>
    mailer.sendOversightAlert(owner!.email, "high_risk_action", `Matched: ${matchedRules}.`, `${publicUrl}/dashboard`),
  );
}

/** Fires from POST /v1/records/{id}/dispute (docs/SPEC.md §13.2) — notifies every
 * participant owner OTHER than the one who raised the dispute. `forceUnsealed` is true only
 * for a legacy sealed record the dispute just opened. */
export async function notifyDisputeRaised(
  db: Db,
  mailer: Mailer,
  log: { warn: (obj: unknown, msg: string) => void },
  recordId: string,
  participantOwnerIds: string[],
  disputedByOwnerId: string,
  publicUrl: string,
  forceUnsealed = false,
): Promise<void> {
  const owners = ownersRepository(db);
  const recordUrl = `${publicUrl}/dashboard`;
  for (const ownerId of participantOwnerIds) {
    if (ownerId === disputedByOwnerId) continue;
    const owner = await owners.findById(ownerId);
    await maybeSend({ mailer, log }, owner, () =>
      mailer.sendOversightAlert(owner!.email, "dispute_raised", forceUnsealed
          ? `Record ${recordId} was disputed by the other owner and is now fully unsealed.`
          : `Record ${recordId} was disputed by the other owner.`, recordUrl),
    );
  }
}
