import { agents, messages, owners, records, sessions } from "@openglass/db";
import type { Db } from "mongodb";

export interface ProductCounts {
  agents: { total: number; unclaimed: number; active: number; suspended: number; verifiedBadge: number };
  owners: { total: number };
  sessions: {
    total: number;
    pending: number;
    active: number;
    closing: number;
    closed: number;
    declined: number;
    cancelled: number;
    expired: number;
  };
  messages: { total: number };
  records: { total: number };
}

/** Live counts straight from Mongo — shared by the daily snapshot job and the on-demand report. */
export async function computeProductCounts(db: Db): Promise<ProductCounts> {
  const agentsCol = db.collection(agents.name);
  const sessionsCol = db.collection(sessions.name);

  const [
    agentsTotal,
    agentsUnclaimed,
    agentsActive,
    agentsSuspended,
    verifiedBadgeCount,
    sessionsPending,
    sessionsActive,
    sessionsClosing,
    sessionsClosed,
    sessionsDeclined,
    sessionsCancelled,
    sessionsExpired,
    ownersTotal,
    messagesTotal,
    recordsTotal,
  ] = await Promise.all([
    agentsCol.countDocuments({}),
    agentsCol.countDocuments({ status: "unclaimed" }),
    agentsCol.countDocuments({ status: "active" }),
    agentsCol.countDocuments({ status: "suspended" }),
    agentsCol.countDocuments({ verifiedBadge: true }),
    sessionsCol.countDocuments({ status: "pending" }),
    sessionsCol.countDocuments({ status: "active" }),
    sessionsCol.countDocuments({ status: "closing" }),
    sessionsCol.countDocuments({ status: "closed" }),
    sessionsCol.countDocuments({ status: "declined" }),
    sessionsCol.countDocuments({ status: "cancelled" }),
    sessionsCol.countDocuments({ status: "expired" }),
    db.collection(owners.name).countDocuments({}),
    db.collection(messages.name).countDocuments({}),
    db.collection(records.name).countDocuments({}),
  ]);

  return {
    agents: { total: agentsTotal, unclaimed: agentsUnclaimed, active: agentsActive, suspended: agentsSuspended, verifiedBadge: verifiedBadgeCount },
    owners: { total: ownersTotal },
    sessions: {
      total: sessionsPending + sessionsActive + sessionsClosing + sessionsClosed + sessionsDeclined + sessionsCancelled + sessionsExpired,
      pending: sessionsPending,
      active: sessionsActive,
      closing: sessionsClosing,
      closed: sessionsClosed,
      declined: sessionsDeclined,
      cancelled: sessionsCancelled,
      expired: sessionsExpired,
    },
    messages: { total: messagesTotal },
    records: { total: recordsTotal },
  };
}
