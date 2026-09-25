import type { MetadataRoute } from "next";

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
  ];
}
