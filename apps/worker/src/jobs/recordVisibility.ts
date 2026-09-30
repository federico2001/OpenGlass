import { encryptPayload, type Evidence, type RecordDoc, type RecordStatement } from "@openglass/db";
import type { ContentEncryptionDeps } from "../domain/contentEncryptionDeps.js";

type Visibility = "private" | "sealed" | "shared";

export interface ResolvedVisibility {
  visibility: Visibility;
  /** Goes on the signed `RecordStatement` — `null` unless `visibility === "private"`. */
  statementRetention: RecordStatement["retention"];
  /** Goes on the `records` collection document — same data as `statementRetention` but as
   * a native `Date` (see collections.ts's `records.retention` doc comment). */
  docRetention: NonNullable<RecordDoc["retention"]> | null;
  sealedState: NonNullable<RecordDoc["sealedState"]> | null;
  encryption: NonNullable<RecordDoc["encryption"]> | null;
}

/**
 * Realignment R1 (docs/SPEC.md §13): resolves a session/attestation's `visibility` into
 * everything `issueRecords`/`issueAttestationRecords` need to finish building the record —
 * and, for `private`, encrypts `evidence.messages`' relay payloads IN PLACE before the
 * caller computes `evidenceSha256`/uploads to S3. This must run before that hash is taken:
 * the signed `evidenceSha256` has to cover the final (encrypted) bytes, not the plaintext
 * the agent originally sent — `envelope.payloadHash` (already computed by the agent at
 * send time) still commits to the plaintext, which is exactly what lets `verifyBundle`
 * (packages/db/src/crypto/verifyBundle.ts) skip that check for `contentState: "encrypted"`
 * messages instead of failing it.
 *
 * Same graceful-degradation rule as the API's `effectiveVisibility`
 * (apps/api/src/domain/visibility.ts): a `private` request without a configured
 * `ContentEncryptionDeps` becomes `shared` (same readers, content kept), never a crash — belt-and-suspenders in case the
 * API and worker's `CONTENT_ENCRYPTION` config ever drift apart between creation and close.
 */
export async function resolveRecordVisibility(opts: {
  requestedVisibility: Visibility | undefined;
  defaultVisibility: Visibility;
  ownerRetentionDaysOverride: number | null | undefined;
  issuedAt: string;
  evidence: Evidence;
  contentEncryption: ContentEncryptionDeps | null;
}): Promise<ResolvedVisibility> {
  const requested = opts.requestedVisibility ?? opts.defaultVisibility;
  const visibility: Visibility = requested === "private" && !opts.contentEncryption ? "shared" : requested;

  if (visibility === "sealed") {
    return {
      visibility,
      statementRetention: null,
      docRetention: null,
      sealedState: { status: "sealed", requestedBy: null, approvals: [], unsealedAt: null, disputedBy: null, disputedAt: null },
      encryption: null,
    };
  }
  if (visibility === "shared") {
    return { visibility, statementRetention: null, docRetention: null, sealedState: null, encryption: null };
  }

  // visibility === "private" ⇒ opts.contentEncryption is non-null (checked above).
  const enc = opts.contentEncryption!;
  const days = opts.ownerRetentionDaysOverride ?? enc.defaultRetentionDays;
  const expiresAtMs = Date.parse(opts.issuedAt) + days * 86_400_000;

  const { plaintextKey, ciphertextKey } = await enc.encryptor.generateDataKey();
  for (const m of opts.evidence.messages) {
    if (!("payload" in m) || m.payload === undefined) continue; // notary mode: nothing to encrypt
    m.payload = encryptPayload(plaintextKey, m.payload);
    m.contentState = "encrypted";
  }

  return {
    visibility,
    statementRetention: { days, expiresAt: new Date(expiresAtMs).toISOString() },
    docRetention: { days, expiresAt: new Date(expiresAtMs) },
    sealedState: null,
    encryption: { dataKeyCiphertext: ciphertextKey, kmsKeyId: enc.kmsKeyId, shredded: false, shreddedAt: null, shreddedReason: null },
  };
}
