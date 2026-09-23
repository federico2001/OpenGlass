import { createPrivateKey, createPublicKey, createSign, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import type { Signature } from "../models/common.js";
import { base64UrlEncode } from "./ed25519.js";
import { sigInput } from "./sigInput.js";

/**
 * The platform countersignature key (SPEC D6): ECDSA P-256, SHA-256. `SIGNER=local` and
 * `SIGNER=kms` must produce byte-compatible signature shapes — both Node's native `crypto`
 * and AWS KMS's `ECDSA_SHA_256` algorithm already emit DER-encoded ECDSA signatures, so no
 * manual re-encoding is needed to keep the two modes interchangeable.
 */
export interface PlatformSigner {
  readonly kid: string;
  readonly alg: "ECDSA_P256_SHA256";
  sign(purpose: string, digest: Uint8Array): Promise<Signature>;
  /** SPKI DER bytes, base64url-encoded — the encoding used for platformKeys.publicKey
   * in `/.well-known/openglass-keys.json` and `RecordBundle.platformKeys`. */
  publicKeyBase64Url(): Promise<string>;
}

export class LocalSigner implements PlatformSigner {
  readonly alg = "ECDSA_P256_SHA256" as const;
  private readonly key: KeyObject;

  constructor(
    readonly kid: string,
    privateKeyPem: string,
  ) {
    this.key = createPrivateKey(privateKeyPem);
  }

  async sign(purpose: string, digest: Uint8Array): Promise<Signature> {
    const message = sigInput(purpose, digest);
    const sig = createSign("sha256").update(message).sign(this.key);
    return { alg: this.alg, kid: this.kid, sig: base64UrlEncode(sig) };
  }

  async publicKeyBase64Url(): Promise<string> {
    const pub = createPublicKey(this.key);
    return base64UrlEncode(pub.export({ format: "der", type: "spki" }));
  }
}

export class KmsSigner implements PlatformSigner {
  readonly alg = "ECDSA_P256_SHA256" as const;
  private readonly client: KMSClient;

  constructor(
    readonly kid: string,
    private readonly keyId: string,
    region?: string,
  ) {
    this.client = new KMSClient({ region });
  }

  async sign(purpose: string, digest: Uint8Array): Promise<Signature> {
    const message = sigInput(purpose, digest);
    const out = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: message,
        MessageType: "RAW",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!out.Signature) throw new Error("KMS Sign returned no signature");
    return { alg: this.alg, kid: this.kid, sig: base64UrlEncode(out.Signature) };
  }

  async publicKeyBase64Url(): Promise<string> {
    const out = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    if (!out.PublicKey) throw new Error("KMS GetPublicKey returned no key");
    return base64UrlEncode(out.PublicKey);
  }
}

export function createPlatformSigner(opts: {
  signer: "local" | "kms";
  kid: string;
  localPrivateKeyPem?: string;
  kmsKeyId?: string;
  awsRegion?: string;
}): PlatformSigner {
  if (opts.signer === "local") {
    if (!opts.localPrivateKeyPem) throw new Error("PLATFORM_SIGNER_LOCAL_KEY is required when SIGNER=local");
    return new LocalSigner(opts.kid, opts.localPrivateKeyPem);
  }
  if (!opts.kmsKeyId) throw new Error("KMS_KEY_ID is required when SIGNER=kms");
  return new KmsSigner(opts.kid, opts.kmsKeyId, opts.awsRegion);
}
