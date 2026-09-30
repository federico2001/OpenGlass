import { createContentEncryptor, type ContentEncryptor } from "@openglass/db";
import type { Config } from "../config.js";

/**
 * Realignment R1 (docs/SPEC.md §13) — the worker-side twin of
 * apps/api/src/domain/contentEncryptionDeps.ts. `null` until `CONTENT_ENCRYPTION` is
 * configured, in which case a `visibility: "private"` session/attestation that reaches
 * issuance falls back to `shared` (same readers, content kept) (see jobs/recordVisibility.ts's
 * resolveRecordVisibility) rather than the worker crashing on a request the API already
 * should have resolved at creation time — defense in depth against the two containers'
 * config drifting apart.
 */
export interface ContentEncryptionDeps {
  encryptor: ContentEncryptor;
  kmsKeyId: string | null;
  defaultRetentionDays: number;
}

export function createContentEncryptionDeps(config: Config): ContentEncryptionDeps | null {
  if (!config.CONTENT_ENCRYPTION) return null;
  const encryptor = createContentEncryptor({
    mode: config.CONTENT_ENCRYPTION,
    localMasterKeyBase64: config.CONTENT_ENCRYPTION_LOCAL_KEY,
    kmsKeyId: config.CONTENT_KMS_KEY_ID,
  });
  return { encryptor, kmsKeyId: config.CONTENT_KMS_KEY_ID ?? null, defaultRetentionDays: config.DEFAULT_PRIVATE_RETENTION_DAYS };
}
