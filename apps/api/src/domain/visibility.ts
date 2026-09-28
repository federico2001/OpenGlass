import { z } from "zod";
import type { ContentEncryptionDeps } from "./contentEncryptionDeps.js";

/** Realignment R1 (docs/SPEC.md §13). A sibling request-body field, not part of the
 * signed offer/open object — same pattern `idleTimeoutSec` already uses for attestations
 * (see packages/db/src/models/collections.ts's own `Visibility` doc comment). */
export const Visibility = z.enum(["private", "sealed", "shared"]);
export type VisibilityValue = z.infer<typeof Visibility>;

/**
 * Resolves the caller's requested `visibility` to what's actually stored: falls back to
 * `defaultVisibility` when omitted (CLAUDE.md "Positioning (Sept 2026)": attestations
 * default `private`, sessions default `sealed`), and gracefully degrades an unsatisfiable
 * `private` request to `sealed` when no `ContentEncryptionDeps` are configured yet — the
 * platform hasn't been given a KMS key/master key to actually encrypt anything with, so it
 * ships the closest available protection instead of erroring. Never silently *upgrades* a
 * caller's explicit `sealed`/`shared` choice.
 */
export function effectiveVisibility(
  requested: VisibilityValue | undefined,
  defaultVisibility: VisibilityValue,
  contentEncryption: ContentEncryptionDeps | null,
): VisibilityValue {
  const chosen = requested ?? defaultVisibility;
  return chosen === "private" && !contentEncryption ? "sealed" : chosen;
}
