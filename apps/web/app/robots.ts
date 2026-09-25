import type { MetadataRoute } from "next";

// Without this, Next.js statically generates this file at build time — baking in
// whatever PUBLIC_URL happened to be set to during `docker build` (nothing; it's only
// injected at container runtime), not the real domain. Matches skill.md/llms.txt/etc.,
// which already have this for the same reason.
export const dynamic = "force-dynamic";

// Explicitly open to everything, including AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
// Google-Extended, …) — being discoverable by agents is the point of this site, not
// something to gate behind a crawler allowlist the way a lot of the web now does.
export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.PUBLIC_URL ?? "https://localhost";
  return {
    // /dashboard is a private, per-owner view (redirects anonymous visitors to /login) —
    // nothing there is meant to be indexed, unlike everything else on this domain.
    rules: { userAgent: "*", allow: "/", disallow: "/dashboard" },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
