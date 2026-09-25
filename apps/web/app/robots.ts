import type { MetadataRoute } from "next";

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
