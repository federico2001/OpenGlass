import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import type { EncryptedPayload } from "../models/protocol.js";
import { base64UrlDecode, base64UrlEncode } from "./ed25519.js";
import { canonicalizeToBytes } from "./canonicalJson.js";

/**
 * Realignment R1 envelope encryption for `visibility: "private"` record content
 * (docs/SPEC.md §13). One data key per record: generated once at issuance, used to
 * AES-256-GCM-encrypt every relay-mode payload in that record's evidence, then wrapped
 * (encrypted) by a long-lived KMS/local master key and stored as `records.encryption.
 * dataKeyCiphertext` — never the plaintext data key. Crypto-shredding is simply deleting
 * that one stored ciphertext (see `packages/db/src/repositories/records.ts`'s
 * `shredContent`): without it, the data key can never be recovered by anyone, KMS
 * access included, so every payload it wrapped becomes permanently unreadable while the
 * evidence bytes (and their hash, and the platform's signature over that hash) never
 * change — this is what "still verifies structurally" means for a shredded record.
 *
 * `SIGNER=local|kms` mirrors this: `CONTENT_ENCRYPTION=local` wraps data keys with a
 * local AES-256-KW master key (dev/test only, no AWS needed); `kms` wraps them with a
 * real symmetric KMS CMK via `GenerateDataKey`/`Decrypt` — a *different* KMS key from the
 * platform's own ECDSA signing key (`SIGNER=kms`'s `KMS_KEY_ID`), since that one is
 * SIGN_VERIFY-only and can't wrap data keys at all.
 */
export interface ContentEncryptor {
  /** A fresh 32-byte AES-256 data key, plus its wrapped (encrypted) form to persist. The
   * plaintext key is never stored — only ever held in memory for the duration of one
   * record's encryption, then discarded. */
  generateDataKey(): Promise<{ plaintextKey: Uint8Array; ciphertextKey: string }>;
  /** Unwraps a previously-generated data key. Throws if `ciphertextKey` doesn't exist —
   * callers check for a shredded (missing) key before calling this, not by catching. */
  decryptDataKey(ciphertextKey: string): Promise<Uint8Array>;
}

export class LocalContentEncryptor implements ContentEncryptor {
  private readonly masterKey: Buffer;

  constructor(masterKeyBase64: string) {
    this.masterKey = Buffer.from(base64UrlDecode(masterKeyBase64));
    if (this.masterKey.length !== 32) throw new Error("CONTENT_ENCRYPTION_LOCAL_KEY must decode to exactly 32 bytes");
  }

  async generateDataKey(): Promise<{ plaintextKey: Uint8Array; ciphertextKey: string }> {
    const plaintextKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrapped = Buffer.concat([iv, authTag, ciphertext]);
    return { plaintextKey, ciphertextKey: base64UrlEncode(wrapped) };
  }

  async decryptDataKey(ciphertextKey: string): Promise<Uint8Array> {
    const wrapped = base64UrlDecode(ciphertextKey);
    const iv = wrapped.subarray(0, 12);
    const authTag = wrapped.subarray(12, 28);
    const ciphertext = wrapped.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

export class KmsContentEncryptor implements ContentEncryptor {
  private readonly client: KMSClient;

  constructor(
    private readonly keyId: string,
    region?: string,
  ) {
    this.client = new KMSClient({ region });
  }

  async generateDataKey(): Promise<{ plaintextKey: Uint8Array; ciphertextKey: string }> {
    const out = await this.client.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256" }));
    if (!out.Plaintext || !out.CiphertextBlob) throw new Error("KMS GenerateDataKey returned no key material");
    return { plaintextKey: out.Plaintext, ciphertextKey: base64UrlEncode(out.CiphertextBlob) };
  }

  async decryptDataKey(ciphertextKey: string): Promise<Uint8Array> {
    const out = await this.client.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: base64UrlDecode(ciphertextKey) }));
    if (!out.Plaintext) throw new Error("KMS Decrypt returned no key material");
    return out.Plaintext;
  }
}

export function createContentEncryptor(opts: {
  mode: "local" | "kms";
  localMasterKeyBase64?: string;
  kmsKeyId?: string;
  awsRegion?: string;
}): ContentEncryptor {
  if (opts.mode === "local") {
    if (!opts.localMasterKeyBase64) throw new Error("CONTENT_ENCRYPTION_LOCAL_KEY is required when CONTENT_ENCRYPTION=local");
    return new LocalContentEncryptor(opts.localMasterKeyBase64);
  }
  if (!opts.kmsKeyId) throw new Error("CONTENT_KMS_KEY_ID is required when CONTENT_ENCRYPTION=kms");
  return new KmsContentEncryptor(opts.kmsKeyId, opts.awsRegion);
}

/** AES-256-GCM-encrypts one payload with an already-unwrapped data key. Payload is
 * canonicalized first (RFC 8785, same as every other hash in this protocol) so
 * encryption operates on the exact bytes `payloadHash` was computed over. */
export function encryptPayload(dataKey: Uint8Array, payload: unknown): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(canonicalizeToBytes(payload)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { v: 1, type: "openglass.encrypted-payload", ciphertext: base64UrlEncode(ciphertext), iv: base64UrlEncode(iv), authTag: base64UrlEncode(authTag) };
}

export function decryptPayload(dataKey: Uint8Array, blob: EncryptedPayload): unknown {
  const decipher = createDecipheriv("aes-256-gcm", dataKey, base64UrlDecode(blob.iv));
  decipher.setAuthTag(base64UrlDecode(blob.authTag));
  const plaintext = Buffer.concat([decipher.update(base64UrlDecode(blob.ciphertext)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
