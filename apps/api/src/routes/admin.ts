import {
  agentsRepository,
  attestations as attestationsCollection,
  checkupEvents as checkupEventsCollection,
  fetchWitnesses as fetchWitnessesCollection,
  owners as ownersCollection,
  records as recordsCollection,
  sessions as sessionsCollection,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { verifyAdminSession } from "../plugins/adminAuth.js";
import type { ServerDeps } from "../server.js";
import { activeAgentParts } from "./live.js";

/** Caps on the itemized lists, so the page stays one response however big the data gets. */
const LIST_MAX = 500;

/**
 * `GET /v1/admin/stats`: what's behind the public /live numbers, itemized, for the
 * operator only (ADMIN_EMAILS, same gate as /v1/admin/integrations/*). Read-only: every
 * call here is a find, count or aggregate. Shows record metadata (who, when, status),
 * never message or attestation content.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const adminAuth = verifyAdminSession(deps.db, { webOrigin: deps.webOrigin, adminEmails: deps.adminEmails });
  const agents = agentsRepository(deps.db);
  const col = (name: string) => deps.db.collection(name);

  app.get("/v1/admin/stats", { preHandler: adminAuth }, async () => {
    const records = col(recordsCollection.name);
    const [parts, sessionsStarted, sessionRecords, attestationRecords] = await Promise.all([
      activeAgentParts(deps, agents),
      col(sessionsCollection.name).countDocuments({}),
      records.countDocuments({ "statement.kind": { $ne: "attestation" } }),
      records.countDocuments({ "statement.kind": "attestation" }),
    ]);

    const [agentDocs, ownerDocs, attestationsByAgent, sessionDocs, witnessed, attestationStatus, recordsByAgent, recordsByDay, checkupEvents, checkupTargets] =
      await Promise.all([
        agents.collection.find({}).sort({ createdAt: -1 }).limit(LIST_MAX).toArray(),
        col(ownersCollection.name).find({}, { projection: { email: 1 } }).toArray(),
        col(attestationsCollection.name)
          .aggregate<{ _id: string; n: number; last: Date }>([{ $group: { _id: "$attestor.agentId", n: { $sum: 1 }, last: { $max: "$createdAt" } } }])
          .toArray(),
        col(sessionsCollection.name)
          .find({}, { projection: { status: 1, mode: 1, initiator: 1, counterparty: 1, createdAt: 1, recordId: 1, messageCount: 1 } })
          .sort({ createdAt: -1 })
          .limit(LIST_MAX)
          .toArray(),
        col(fetchWitnessesCollection.name)
          .aggregate<{ _id: string; n: number; by: string[]; first: Date; last: Date }>([
            { $match: { domain: { $type: "string" } } },
            { $group: { _id: "$domain", n: { $sum: 1 }, by: { $addToSet: "$requestedBy" }, first: { $min: "$fetchedAt" }, last: { $max: "$fetchedAt" } } },
            { $sort: { n: -1 } },
            { $limit: LIST_MAX },
          ])
          .toArray(),
        col(attestationsCollection.name).aggregate<{ _id: string; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
        records
          .aggregate<{ _id: string; n: number }>([
            { $match: { "statement.kind": "attestation" } },
            { $unwind: "$participantAgentIds" },
            { $group: { _id: "$participantAgentIds", n: { $sum: 1 } } },
            { $sort: { n: -1 } },
          ])
          .toArray(),
        records
          .aggregate<{ _id: string; n: number }>([
            { $match: { "statement.kind": "attestation" } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 } } },
            { $sort: { _id: -1 } },
            { $limit: 60 },
          ])
          .toArray(),
        col(checkupEventsCollection.name)
          .aggregate<{ _id: { kind: string; source: string }; n: number }>([
            { $group: { _id: { kind: "$kind", source: "$source" }, n: { $sum: 1 } } },
            { $sort: { "_id.kind": 1, "_id.source": 1 } },
          ])
          .toArray(),
        col(checkupEventsCollection.name)
          .aggregate<{ _id: { target: string | null; source: string }; n: number; last: Date }>([
            { $match: { kind: "check_run" } },
            { $group: { _id: { target: "$targetKey", source: "$source" }, n: { $sum: 1 }, last: { $max: "$at" } } },
            { $sort: { n: -1 } },
            { $limit: 50 },
          ])
          .toArray(),
      ]);

    const ownerEmail = new Map(ownerDocs.map((o) => [o._id as unknown as string, o.email as string]));
    const agentName = new Map(agentDocs.map((a) => [a._id, a.name]));
    const nameOf = (id: string | null | undefined) => (id ? (agentName.get(id) ?? null) : null);
    const attestationCount = new Map(attestationsByAgent.map((r) => [r._id, r]));
    const sessionCount = new Map<string, number>();
    for (const s of sessionDocs) {
      for (const id of [s.initiator?.agentId, s.counterparty?.agentId]) if (id) sessionCount.set(id, (sessionCount.get(id) ?? 0) + 1);
    }
    const external = new Set(parts.externalWitnessedDomains);
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

    return {
      generatedAt: new Date().toISOString(),
      live: {
        activeAgents: parts.registeredAgents + parts.externalWitnessedDomains.length,
        registeredAgents: parts.registeredAgents,
        witnessedDomains: parts.externalWitnessedDomains.length,
        sessionsStarted,
        sessionRecords,
        attestationRecords,
      },
      agents: agentDocs.map((a) => ({
        id: a._id,
        name: a.name,
        status: a.status,
        countedAsActive: a.status !== "unclaimed",
        ownerEmail: a.ownerId ? (ownerEmail.get(a.ownerId) ?? null) : null,
        homepage: a.meta.homepage ?? null,
        verifiedDomain: a.domainVerification?.status === "verified" ? a.domainVerification.domain : null,
        createdAt: a.createdAt.toISOString(),
        attestations: attestationCount.get(a._id)?.n ?? 0,
        lastAttestationAt: iso(attestationCount.get(a._id)?.last),
        sessions: sessionCount.get(a._id) ?? 0,
      })),
      witnessedDomains: witnessed.map((w) => ({
        domain: w._id,
        countedAsActive: external.has(w._id),
        fetches: w.n,
        requestedBy: w.by.map((id) => ({ id, name: nameOf(id) })),
        firstAt: iso(w.first),
        lastAt: iso(w.last),
      })),
      sessions: sessionDocs.map((s) => ({
        id: s._id as unknown as string,
        status: s.status as string,
        mode: s.mode as string,
        createdAt: iso(s.createdAt),
        messageCount: (s.messageCount as number | undefined) ?? 0,
        recordIssued: !!s.recordId,
        initiator: { id: s.initiator?.agentId ?? null, name: nameOf(s.initiator?.agentId) },
        counterparty: { id: s.counterparty?.agentId ?? null, name: nameOf(s.counterparty?.agentId) },
      })),
      attestations: {
        byStatus: Object.fromEntries(attestationStatus.map((r) => [r._id, r.n])),
        recordsByAgent: recordsByAgent.map((r) => ({ id: r._id, name: nameOf(r._id), records: r.n })),
        recordsByDay: recordsByDay.map((r) => ({ day: r._id, records: r.n })),
      },
      checkup: {
        events: checkupEvents.map((r) => ({ kind: r._id.kind, source: r._id.source, count: r.n })),
        targets: checkupTargets.map((r) => ({ target: r._id.target, source: r._id.source, runs: r.n, lastAt: iso(r.last) })),
      },
    };
  });
}
