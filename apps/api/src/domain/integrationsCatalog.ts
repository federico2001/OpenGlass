import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The static framework catalog for the /integrations request board (Prompt 23) — see
 * ../../data/integrations.yaml for the actual content and why it's a YAML file rather
 * than a Mongo collection. `import.meta.url`-relative resolution (not `process.cwd()`)
 * so this finds the file the same way whether running from `src/` (tests, dev) or the
 * built `dist/` (Docker) — both sit exactly two directories under the package root.
 */
const CatalogEntry = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  name: z.string().min(1).max(200),
  url: z.url(),
  description: z.string().min(1).max(1000),
  category: z.string().min(1).max(50),
  defaultStatus: z.enum(["requested", "in_progress", "available", "native"]),
  evidence: z.array(z.strictObject({ label: z.string().min(1).max(200), url: z.url() })),
});
const Catalog = z.strictObject({ frameworks: z.array(CatalogEntry) });

export type IntegrationCatalogEntry = z.infer<typeof CatalogEntry>;

let cached: IntegrationCatalogEntry[] | undefined;

export function loadIntegrationsCatalog(): IntegrationCatalogEntry[] {
  if (cached) return cached;
  const filePath = new URL("../../data/integrations.yaml", import.meta.url);
  const raw = parseYaml(readFileSync(filePath, "utf8"));
  const parsed = Catalog.parse(raw);

  const seen = new Set<string>();
  for (const f of parsed.frameworks) {
    if (seen.has(f.slug)) throw new Error(`duplicate integration slug "${f.slug}" in integrations.yaml`);
    seen.add(f.slug);
  }

  cached = parsed.frameworks;
  return cached;
}
