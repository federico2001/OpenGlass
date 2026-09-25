import type { PlatformKey, PlatformSigner } from "@openglass/db";

/**
 * No key-rotation history is tracked in this MVP — there is always exactly one active
 * platform key. `validFrom` still has to be a real, defensible date rather than the Unix
 * epoch: verification (SPEC §7.6) checks every platform signature falls inside
 * `[validFrom, validUntil)`, so this only needs to be **at or before** the earliest record
 * this key ever signed — never after, or historical signatures stop verifying.
 *
 * The project's first commit predates any record this key could have signed, so it's a
 * safe, honest default. Set `PLATFORM_KEY_VALID_FROM` to the key's actual creation date
 * when you know it (e.g. when rotating to a new KMS key — see the rotation note below).
 */
export const PLATFORM_KEY_GENESIS_DATE = "2026-09-22T22:07:25.000Z";

/**
 * Key rotation (D6 follow-up, not yet built): today `trustedPlatformKeys` always returns
 * a single-element array for the signer's current `kid`. Rotating in a new key means: (1)
 * generate the new key and deploy it as the *new* `PLATFORM_KID`/`PLATFORM_SIGNER_LOCAL_KEY`
 * (or `KMS_KEY_ID`), (2) keep the retiring key's material available and list it here too,
 * with `validUntil` set to the rotation instant, so records it already signed keep
 * verifying, (3) set `PLATFORM_KEY_VALID_FROM` for the new key to that same instant. This
 * function will need to return both keys until every record signed by the old one falls
 * outside any caller's verification window.
 */
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
