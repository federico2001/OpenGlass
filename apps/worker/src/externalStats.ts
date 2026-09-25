export interface ExternalStats {
  npmWeeklyDownloads: number | null;
  pypiDailyDownloads: number | null;
  pypiWeeklyDownloads: number | null;
  pypiMonthlyDownloads: number | null;
  github: {
    stars: number | null;
    forks: number | null;
    watchers: number | null;
    openIssues: number | null;
  };
}

const NULL_STATS: ExternalStats = {
  npmWeeklyDownloads: null,
  pypiDailyDownloads: null,
  pypiWeeklyDownloads: null,
  pypiMonthlyDownloads: null,
  github: { stars: null, forks: null, watchers: null, openIssues: null },
};

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": "openglass-activity-worker", ...headers } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Best-effort: any source that fails (rate limit, transient outage, package not found yet)
 * contributes `null` fields rather than failing the whole report — these are public,
 * unauthenticated third-party APIs outside our control. */
export async function fetchExternalStats(log: (msg: string, meta?: Record<string, unknown>) => void = () => {}): Promise<ExternalStats> {
  const stats = structuredClone(NULL_STATS);

  await Promise.all([
    getJson("https://api.npmjs.org/downloads/point/last-week/openglass-sdk")
      .then((d) => {
        stats.npmWeeklyDownloads = (d as { downloads: number }).downloads;
      })
      .catch((err) => log("npm downloads fetch failed", { err: String(err) })),

    getJson("https://pypistats.org/api/packages/openglass-sdk/recent")
      .then((d) => {
        const data = (d as { data: { last_day: number; last_week: number; last_month: number } }).data;
        stats.pypiDailyDownloads = data.last_day;
        stats.pypiWeeklyDownloads = data.last_week;
        stats.pypiMonthlyDownloads = data.last_month;
      })
      .catch((err) => log("pypi downloads fetch failed", { err: String(err) })),

    getJson("https://api.github.com/repos/federico2001/OpenGlass")
      .then((d) => {
        const repo = d as { stargazers_count: number; forks_count: number; subscribers_count: number; open_issues_count: number };
        stats.github = {
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          watchers: repo.subscribers_count,
          openIssues: repo.open_issues_count,
        };
      })
      .catch((err) => log("github stats fetch failed", { err: String(err) })),
  ]);

  return stats;
}
