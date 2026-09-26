import type { MetadataRoute } from "next";

// Without this, Next.js statically generates this file at build time — baking in
// whatever PUBLIC_URL happened to be set to during `docker build` (nothing; it's only
// injected at container runtime), not the real domain. Matches skill.md/llms.txt/etc.,
// which already have this for the same reason.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.PUBLIC_URL ?? "https://localhost";
  const now = new Date();
  return [
    { url: `${baseUrl}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${baseUrl}/skill.md`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${baseUrl}/llms.txt`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${baseUrl}/llms-full.txt`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${baseUrl}/docs/SPEC.md`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${baseUrl}/docs/openapi.yaml`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${baseUrl}/login`, lastModified: now, changeFrequency: "yearly", priority: 0.5 },
    { url: `${baseUrl}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/security`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/live`, lastModified: now, changeFrequency: "always", priority: 0.8 },
    { url: `${baseUrl}/directory`, lastModified: now, changeFrequency: "hourly", priority: 0.6 },
  ];
}
