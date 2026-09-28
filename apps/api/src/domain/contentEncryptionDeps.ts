import { createContentEncryptor, type ContentEncryptor } from "@openglass/db";
import type { Config } from "../config.js";

/**
 * Realignment R1 (docs/SPEC.md §13): envelope encryption for `visibility: "private"`
 * record content. `null` when `CONTENT_ENCRYPTION` isn't configured, in which case a
 * `visibility: "private"` request gracefully degrades to `sealed` (see
 * apps/api/src/routes/sessions.ts / attestations.ts) rather than erroring — mirrors
 * `createX402Deps`'s "off until a real payout wallet is set" pattern exactly.
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
