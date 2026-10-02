import { checkupEvents, checkupReports, rateLimitsRepository, type CheckupEventDoc, type CheckupReportDoc } from "@openglass/db";
import { ObjectId, type Db } from "mongodb";

export const CACHE_TTL_MS = 3_600_000;
/** How long a report (and its links) stays readable. */
const REPORT_RETENTION_MS = 365 * 24 * 3_600_000;

export interface RateRule {
  limit: number;
  windowMs: number;
}

/** Fresh checks only: a cached result costs the target nothing, so it isn't counted
 * against the per-target limit (it is against the caller's, more loosely). */
export const RATE_RULES = {
  checkup_caller: { limit: 20, windowMs: 3_600_000 },
  checkup_caller_cached: { limit: 120, windowMs: 3_600_000 },
  checkup_target: { limit: 6, windowMs: 3_600_000 },
  checkup_bundle: { limit: 60, windowMs: 60_000 },
} as const satisfies Record<string, RateRule>;

export type RateRuleName = keyof typeof RATE_RULES;
export type EventKind = CheckupEventDoc["kind"];
export type Source = CheckupEventDoc["source"];

export function createStore(db: Db) {
  const reports = db.collection<CheckupReportDoc>(checkupReports.name);
  const events = db.collection<CheckupEventDoc>(checkupEvents.name);
  const limits = rateLimitsRepository(db);

  return {
    async freshReport(targetKey: string, now = new Date()): Promise<CheckupReportDoc | null> {
      return reports.findOne({ targetKey, createdAt: { $gt: new Date(now.getTime() - CACHE_TTL_MS) } }, { sort: { createdAt: -1 } });
    },
    async saveReport(doc: Omit<CheckupReportDoc, "expiresAt">): Promise<void> {
      await reports.insertOne({ ...doc, expiresAt: new Date(doc.createdAt.getTime() + REPORT_RETENTION_MS) });
    },
    getReport: (id: string) => reports.findOne({ _id: id }),
    async setRecordId(id: string, recordId: string): Promise<void> {
      await reports.updateOne({ _id: id }, { $set: { recordId } });
    },
    async recentReports(limit: number) {
      const docs = await reports
        .find({}, { projection: { targetKey: 1, createdAt: 1, attestationId: 1, "report.overall": 1 } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => ({
        id: d._id,
        targetKey: d.targetKey,
        createdAt: d.createdAt,
        overall: typeof d.report?.overall === "number" ? d.report.overall : null,
        recorded: d.attestationId !== null,
      }));
    },
    reportsByIds: (ids: string[]) => reports.find({ _id: { $in: ids } }).toArray(),

    async event(kind: EventKind, source: Source, targetKey: string | null, reportId: string | null): Promise<void> {
      await events.insertOne({ _id: new ObjectId(), kind, source, targetKey, reportId, at: new Date() });
    },

    /** `limited` once this call pushed the window's count past the rule's limit. */
    async hit(rule: RateRuleName, key: string): Promise<{ limited: boolean; retryAfterSec: number }> {
      const { limit, windowMs } = RATE_RULES[rule];
      const { count, resetAt } = await limits.increment(rule, key, windowMs, new Date());
      return { limited: count > limit, retryAfterSec: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) };
    },

    async metrics(since: Date) {
      const match = { at: { $gte: since } };
      const counts = await events
        .aggregate<{ _id: { kind: EventKind; source: Source }; n: number }>([{ $match: match }, { $group: { _id: { kind: "$kind", source: "$source" }, n: { $sum: 1 } } }])
        .toArray();
      const count = (kind: EventKind, source?: Source) =>
        counts.filter((c) => c._id.kind === kind && (!source || c._id.source === source)).reduce((sum, c) => sum + c.n, 0);
      const uniqueTargets = (await events.distinct("targetKey", { ...match, kind: { $in: ["check_run", "cache_hit"] }, targetKey: { $ne: null } })).length;
      return {
        checksRun: count("check_run", "user"),
        registryProbes: count("check_run", "registry"),
        cacheHits: count("cache_hit"),
        uniqueTargets,
        reportOpens: count("report_open"),
        claimClicks: count("claim_click"),
        unclaimedListed: count("unclaimed_listed"),
      };
    },

    /** Report ids whose claim link was clicked, most recent first. */
    async clickedClaimReportIds(limit: number): Promise<string[]> {
      const rows = await events
        .aggregate<{ _id: string }>([
          { $match: { kind: "claim_click", reportId: { $ne: null } } },
          { $group: { _id: "$reportId", last: { $max: "$at" } } },
          { $sort: { last: -1 } },
          { $limit: limit },
        ])
        .toArray();
      return rows.map((r) => r._id);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
