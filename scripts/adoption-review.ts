/**
 * Weekly adoption review for the /integrations request board (Prompt 27): a runnable
 * report you (or your own cron) run on demand, not an autonomous job — nothing here
 * drafts or sends anything to anyone without a human reading it first. Prints a vote
 * leaderboard, the 3 frameworks to prioritize next, and any new "request my framework"
 * submissions from the last 7 days.
 *
 * Usage: node --experimental-strip-types scripts/adoption-review.ts
 * Optional env vars:
 *   OPENGLASS_BASE_URL         Default https://openglass.glass
 *   OG_ADMIN_SESSION_COOKIE    An ADMIN_EMAILS-allowlisted owner's "og_session=..."
 *                              cookie, to also include the request queue (admin-only).
 *                              Without it, the report covers votes/status only, which
 *                              are public.
 */
const BASE_URL = process.env.OPENGLASS_BASE_URL ?? "https://openglass.glass";
const ADMIN_COOKIE = process.env.OG_ADMIN_SESSION_COOKIE;

interface IntegrationCard {
  slug: string;
  name: string;
  status: "requested" | "in_progress" | "available" | "native";
  voteCount: number;
}

interface IntegrationRequest {
  id: string;
  frameworkName: string;
  frameworkUrl: string | null;
  note: string | null;
  requesterEmail: string;
  createdAt: string;
}

async function fetchCatalog(): Promise<IntegrationCard[]> {
  const res = await fetch(`${BASE_URL}/v1/integrations`);
  if (!res.ok) throw new Error(`GET /v1/integrations -> ${res.status}`);
  const { items } = (await res.json()) as { items: IntegrationCard[] };
  return items;
}

/** Returns `null` (not an error) when no admin session was supplied, or the server
 * rejected it — the rest of the report still stands on its own without this section. */
async function fetchRequests(): Promise<IntegrationRequest[] | null> {
  if (!ADMIN_COOKIE) return null;
  const res = await fetch(`${BASE_URL}/v1/admin/integrations/requests?limit=200`, { headers: { cookie: ADMIN_COOKIE } });
  if (res.status === 401 || res.status === 403) {
    console.error(`Note: admin session was rejected (${res.status}) — skipping the request-queue section.`);
    return null;
  }
  if (!res.ok) throw new Error(`GET /v1/admin/integrations/requests -> ${res.status}`);
  const { items } = (await res.json()) as { items: IntegrationRequest[] };
  return items;
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function pluralVotes(n: number): string {
  return `${n} vote${n === 1 ? "" : "s"}`;
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`# OpenGlass integrations — weekly adoption review (${today})\n`);

  const catalog = await fetchCatalog();

  console.log("## Vote leaderboard\n");
  for (const item of [...catalog].sort((a, b) => b.voteCount - a.voteCount)) {
    console.log(`- **${item.name}** (${item.status}) — ${pluralVotes(item.voteCount)}`);
  }

  console.log("\n## Suggested next 3 frameworks to build\n");
  const suggestions = catalog
    .filter((c) => c.status === "requested")
    .sort((a, b) => b.voteCount - a.voteCount)
    .slice(0, 3);
  if (suggestions.length === 0) {
    console.log('- Nothing currently at "requested" status with votes yet — check back once some come in.');
  } else {
    for (const s of suggestions) console.log(`- **${s.name}** — ${pluralVotes(s.voteCount)}, currently "requested"`);
  }

  console.log("\n## New requests (last 7 days)\n");
  const requests = await fetchRequests();
  if (requests === null) {
    console.log("_Set `OG_ADMIN_SESSION_COOKIE` (an admin-allowlisted owner's session) to include this section._");
  } else {
    const recent = requests.filter((r) => daysAgo(r.createdAt) <= 7);
    if (recent.length === 0) {
      console.log("- None.");
    } else {
      for (const r of recent) {
        const link = r.frameworkUrl ? ` (${r.frameworkUrl})` : "";
        const note = r.note ? ` — "${r.note}"` : "";
        console.log(`- **${r.frameworkName}**${link}, requested by ${r.requesterEmail}${note}`);
      }
    }
  }

  console.log("\n## Stalled native PRs\n");
  console.log(
    "_No native framework PRs exist yet to report on — opening one against a third-party repo needs your explicit " +
      "go-ahead each time, so none has been opened autonomously. Once one exists, extend this script to check its " +
      "age/review status via that repo's own API and draft (never send) a follow-up here for you to read first._",
  );
}

main().catch((err) => {
  console.error("\nAdoption review failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
