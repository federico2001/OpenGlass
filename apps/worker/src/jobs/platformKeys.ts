import type { PlatformKey, PlatformSigner } from "@openglass/db";

/** No key-rotation history is tracked in this MVP — mirrors apps/api's domain/platformKeys.ts,
 * including the rotation note there. `validFrom` must stay at or before the earliest record
 * this key ever signed. */
export const PLATFORM_KEY_GENESIS_DATE = "2026-09-22T22:07:25.000Z";

export async function trustedPlatformKeys(signer: PlatformSigner, validFrom: string = PLATFORM_KEY_GENESIS_DATE): Promise<PlatformKey[]> {
  return [
    {
      kid: signer.kid,
      alg: signer.alg,
      publicKey: await signer.publicKeyBase64Url(),
      validFrom,
      validUntil: null,
    },
  ];
}
