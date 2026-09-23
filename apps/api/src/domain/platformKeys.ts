import type { PlatformKey, PlatformSigner } from "@openglass/db";

/** No key-rotation history is tracked in this MVP — there is always exactly one active
 * platform key, so `validFrom` is a fixed epoch rather than a tracked issuance date. */
export const PLATFORM_KEY_VALID_FROM = "1970-01-01T00:00:00.000Z";

export async function trustedPlatformKeys(signer: PlatformSigner): Promise<PlatformKey[]> {
  return [
    {
      kid: signer.kid,
      alg: signer.alg,
      publicKey: await signer.publicKeyBase64Url(),
      validFrom: PLATFORM_KEY_VALID_FROM,
      validUntil: null,
    },
  ];
}
