import { activitySnapshotsRepository, type ActivitySnapshotDoc } from "@openglass/db";
import type { Db } from "mongodb";
import { fetchExternalStats, type ExternalStats } from "../externalStats.js";
import { computeProductCounts } from "../productCounts.js";

const DUPLICATE_KEY_ERROR_CODE = 11000;

const utcDateString = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Writes one document per UTC calendar day summarizing product + package/registry activity,
 * so "how's activity looking" can be answered from history, not just a live snapshot. Runs
 * from the worker's existing poll loop (apps/worker/src/index.ts); the `_id`-on-date unique
 * index makes re-running within the same day a no-op, so the poll interval doesn't matter.
 */
export async function recordActivitySnapshot(
  db: Db,
  opts: { now?: Date; fetchStats?: () => Promise<ExternalStats>; log?: (msg: string, meta?: Record<string, unknown>) => void } = {},
): Promise<{ written: boolean }> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const today = utcDateString(now);
  const repo = activitySnapshotsRepository(db);

  if (await repo.findById(today)) return { written: false };

  const [counts, external] = await Promise.all([computeProductCounts(db), (opts.fetchStats ?? (() => fetchExternalStats(log)))()]);

  const doc: ActivitySnapshotDoc = {
    _id: today,
    takenAt: now,
    agents: counts.agents,
    owners: counts.owners,
    sessions: counts.sessions,
    messages: counts.messages,
    records: counts.records,
    packages: {
      npmWeeklyDownloads: external.npmWeeklyDownloads,
      pypiDailyDownloads: external.pypiDailyDownloads,
      pypiWeeklyDownloads: external.pypiWeeklyDownloads,
      pypiMonthlyDownloads: external.pypiMonthlyDownloads,
    },
    github: external.github,
  };

  try {
    await repo.insert(doc);
  } catch (err) {
    // Another worker replica wrote today's snapshot in the race between findById and insert.
    if ((err as { code?: number }).code !== DUPLICATE_KEY_ERROR_CODE) throw err;
    return { written: false };
  }
  return { written: true };
}
