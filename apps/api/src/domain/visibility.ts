import { z } from "zod";
import type { ContentEncryptionDeps } from "./contentEncryptionDeps.js";

/** Realignment R1 (docs/SPEC.md §13). A sibling request-body field, not part of the
 * signed offer/open object — same pattern `idleTimeoutSec` already uses for attestations
 * (see packages/db/src/models/collections.ts's own `Visibility` doc comment). `sealed` is
 * deprecated for new records (§13.2): still accepted when a caller asks for it explicitly,
 * never chosen by a platform default. */
export const Visibility = z.enum(["private", "sealed", "shared"]);
export type VisibilityValue = z.infer<typeof Visibility>;

/**
 * Resolves the caller's requested `visibility` to what's actually stored, in priority
 * order: (1) the request's own explicit `visibility`, (2) the initiating agent's own
 * `agents.defaultVisibility` (realignment R4, owner-set via
 * `PATCH /v1/owner/agents/{id}/visibility-default`), (3) the platform default
 * (docs/SPEC.md §13: attestations default `private`, sessions default `shared` — both
 * participant owners see a session record in full from the moment it's issued) — then
 * falls back from an unsatisfiable `private` result to `shared` when no
 * `ContentEncryptionDeps` are configured yet (the platform hasn't been given a key to
 * encrypt anything with). `shared` has the same readers as `private` (the participant
 * owners, never the public); only the retention-and-erase part can't be honored, so the
 * content is kept. It never falls back to `sealed`, which is deprecated and never a
 * default (docs/SPEC.md §13). Never silently *upgrades* a caller's explicit
 * `sealed`/`shared` choice — an agent-level default only ever fills in an omission.
 */
export function effectiveVisibility(
  requested: VisibilityValue | undefined,
  agentDefault: VisibilityValue | null | undefined,
  platformDefault: VisibilityValue,
  contentEncryption: ContentEncryptionDeps | null,
): VisibilityValue {
  const chosen = requested ?? agentDefault ?? platformDefault;
  return chosen === "private" && !contentEncryption ? "shared" : chosen;
}
