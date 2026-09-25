#!/usr/bin/env node
// Standalone CLI (not part of the server process): `node dist/activityReport.js`.
// Prints live product counts plus recent daily snapshots as JSON, for on-demand querying
// (e.g. via `docker compose exec worker node dist/activityReport.js` against production).
import { activitySnapshotsRepository, connectFromEnv } from "@openglass/db";
import { fetchExternalStats } from "./externalStats.js";
import { computeProductCounts } from "./productCounts.js";

const HISTORY_DAYS = 30;

async function main() {
  const conn = await connectFromEnv("openglass-activity-report");
  try {
    const [live, external, history] = await Promise.all([
      computeProductCounts(conn.db),
      fetchExternalStats(),
      activitySnapshotsRepository(conn.db).listRecent(HISTORY_DAYS),
    ]);

    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          live,
          packages: {
            npmWeeklyDownloads: external.npmWeeklyDownloads,
            pypiDailyDownloads: external.pypiDailyDownloads,
            pypiWeeklyDownloads: external.pypiWeeklyDownloads,
            pypiMonthlyDownloads: external.pypiMonthlyDownloads,
          },
          github: external.github,
          history: history.reverse(), // oldest -> newest
        },
        null,
        2,
      ),
    );
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
