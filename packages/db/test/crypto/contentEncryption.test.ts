import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64UrlEncode } from "../../src/crypto/ed25519.js";
import { createContentEncryptor, decryptPayload, encryptPayload, LocalContentEncryptor } from "../../src/crypto/contentEncryption.js";

function localEncryptor(): LocalContentEncryptor {
  return new LocalContentEncryptor(base64UrlEncode(randomBytes(32)));
}

describe("LocalContentEncryptor", () => {
  it("wraps and unwraps a data key round-trip", async () => {
    const encryptor = localEncryptor();
    const { plaintextKey, ciphertextKey } = await encryptor.generateDataKey();
    expect(plaintextKey).toHaveLength(32);
    const recovered = await encryptor.decryptDataKey(ciphertextKey);
    expect(Buffer.from(recovered)).toEqual(Buffer.from(plaintextKey));
  });

  it("produces a different data key and ciphertext each call", async () => {
    const encryptor = localEncryptor();
    const a = await encryptor.generateDataKey();
    const b = await encryptor.generateDataKey();
    expect(Buffer.from(a.plaintextKey)).not.toEqual(Buffer.from(b.plaintextKey));
    expect(a.ciphertextKey).not.toEqual(b.ciphertextKey);
  });

  it("refuses to unwrap with a different master key (wrong-key / tampered ciphertext)", async () => {
    const a = localEncryptor();
    const b = localEncryptor();
    const { ciphertextKey } = await a.generateDataKey();
    await expect(b.decryptDataKey(ciphertextKey)).rejects.toThrow();
  });

  it("rejects a master key that isn't exactly 32 bytes", () => {
    expect(() => new LocalContentEncryptor(base64UrlEncode(randomBytes(16)))).toThrow(/32 bytes/);
  });

  it("createContentEncryptor throws a clear error when local mode is missing its key", () => {
    expect(() => createContentEncryptor({ mode: "local" })).toThrow(/CONTENT_ENCRYPTION_LOCAL_KEY/);
  });

  it("createContentEncryptor throws a clear error when kms mode is missing its key id", () => {
    expect(() => createContentEncryptor({ mode: "kms" })).toThrow(/CONTENT_KMS_KEY_ID/);
  });
});

describe("encryptPayload / decryptPayload", () => {
  it("round-trips an arbitrary JSON payload", () => {
    const dataKey = randomBytes(32);
    const payload = { proposal: { deliveryDate: "2026-10-01", amountUsd: 500, tags: ["urgent", "po-4411"] } };
    const blob = encryptPayload(dataKey, payload);
    expect(blob).toEqual({ v: 1, type: "openglass.encrypted-payload", ciphertext: expect.any(String), iv: expect.any(String), authTag: expect.any(String) });
    expect(decryptPayload(dataKey, blob)).toEqual(payload);
  });

  it("fails to decrypt with the wrong data key", () => {
    const blob = encryptPayload(randomBytes(32), { a: 1 });
    expect(() => decryptPayload(randomBytes(32), blob)).toThrow();
  });

  it("fails to decrypt if the ciphertext was tampered with", () => {
    const dataKey = randomBytes(32);
    const blob = encryptPayload(dataKey, { a: 1 });
    const tampered = { ...blob, ciphertext: blob.ciphertext.slice(0, -4) + "AAAA" };
    expect(() => decryptPayload(dataKey, tampered)).toThrow();
  });
});
