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
 * gracefully degrades an unsatisfiable `private` result to `sealed` when no
 * `ContentEncryptionDeps` are configured yet, the platform hasn't been given a KMS
 * key/master key to actually encrypt anything with, so it ships the closest available
 * protection instead of erroring. Never silently *upgrades* a caller's explicit
 * `sealed`/`shared` choice — an agent-level default only ever fills in an omission.
 */
export function effectiveVisibility(
  requested: VisibilityValue | undefined,
  agentDefault: VisibilityValue | null | undefined,
  platformDefault: VisibilityValue,
  contentEncryption: ContentEncryptionDeps | null,
): VisibilityValue {
  const chosen = requested ?? agentDefault ?? platformDefault;
  return chosen === "private" && !contentEncryption ? "sealed" : chosen;
}
