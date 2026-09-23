import { generateKeyPairSync } from "node:crypto";
import { canonicalizeToBytes } from "../../src/crypto/canonicalJson.js";
import { base64UrlEncode, generateEd25519KeyPair, signEd25519 } from "../../src/crypto/ed25519.js";
import { hex, hexToBytes, sha256 } from "../../src/crypto/hash.js";
import { LocalSigner, type PlatformSigner } from "../../src/crypto/platformSigner.js";
import { sigInput } from "../../src/crypto/sigInput.js";
import type { RecordBundle } from "../../src/models/protocol.js";

/** Builds a fully real, fully valid, independently verifiable `RecordBundle` — genuine
 * Ed25519 agent signatures and a genuine local ECDSA P-256 platform signer, not fixture
 * placeholders — for testing `verifyBundle`. `tamper` lets a test corrupt exactly one
 * field of the finished bundle to exercise a specific §7.6 failure. */
export async function buildTestBundle(opts: { tamper?: (bundle: RecordBundle) => void } = {}): Promise<{
  bundle: RecordBundle;
  platformKid: string;
}> {
  const now = new Date();
  const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString();

  const initiator = generateEd25519KeyPair();
  const counterparty = generateEd25519KeyPair();
  const A = { agentId: "agt_01J8Z3K4M5N6P7Q8R9S0T1V2WA", kid: "key_01J8Z3K4M5N6P7Q8R9S0T1V2WB", publicKey: base64UrlEncode(initiator.publicKey) };
  const B = { agentId: "agt_01J8Z3K4M5N6P7Q8R9S0T1V2WC", kid: "key_01J8Z3K4M5N6P7Q8R9S0T1V2WD", publicKey: base64UrlEncode(counterparty.publicKey) };
  const ownerA = "own_01J8Z3K4M5N6P7Q8R9S0T1V2WE";
  const ownerB = "own_01J8Z3K4M5N6P7Q8R9S0T1V2WF";
  const sessionId = "ses_01J8Z3K4M5N6P7Q8R9S0T1V2WG";
  const recordId = "rec_01J8Z3K4M5N6P7Q8R9S0T1V2WH";

  const platformKid = "plat_test";
  const { privateKey: platformPem } = generateEcP256Pem();
  const platform: PlatformSigner = new LocalSigner(platformKid, platformPem);

  const sign = (priv: Uint8Array, kid: string, purpose: string, digest: Uint8Array) => ({
    alg: "Ed25519" as const,
    kid,
    sig: base64UrlEncode(signEd25519(sigInput(purpose, digest), priv)),
  });

  const offer = {
    v: 1 as const,
    type: "openglass.offer" as const,
    sessionId,
    mode: "relay" as const,
    purpose: "Negotiate delivery date for PO 4411",
    initiator: A,
    counterparty: { agentId: B.agentId },
    idleTimeoutSec: 86400,
    createdAt: iso(),
    expiresAt: iso(86_400_000),
  };
  const offerHashBytes = sha256(canonicalizeToBytes(offer));
  const offerSignature = sign(initiator.privateKey, A.kid, "offer", offerHashBytes);

  const accept = {
    v: 1 as const,
    type: "openglass.accept" as const,
    sessionId,
    offerHash: hex(offerHashBytes),
    counterparty: B,
    acceptedAt: iso(1000),
  };
  const acceptSignature = sign(counterparty.privateKey, B.kid, "accept", sha256(canonicalizeToBytes(accept)));

  const genesisHashBytes = sha256(canonicalizeToBytes({ offer, offerSignature, accept, acceptSignature }));
  const genesisHash = hex(genesisHashBytes);
  const genesisSignature = await platform.sign("genesis", genesisHashBytes);

  const payload = { proposal: { deliveryDate: "2026-10-01" } };
  const payloadHash = hex(sha256(canonicalizeToBytes(payload)));
  const envelope = {
    v: 1 as const,
    type: "openglass.message" as const,
    sessionId,
    seq: 1,
    prevHash: genesisHash,
    sender: { agentId: A.agentId, kid: A.kid },
    contentType: "application/json",
    payloadHash,
    sentAt: iso(2000),
  };
  const msgHashBytes = sha256(Buffer.concat([hexToBytes(genesisHash), canonicalizeToBytes(envelope)]));
  const msgHash = hex(msgHashBytes);
  const msgSignature = sign(initiator.privateKey, A.kid, "message", msgHashBytes);
  const receivedAt = iso(2100);
  const countersignDigest = sha256(canonicalizeToBytes({ hash: msgHash, agentSig: msgSignature.sig, receivedAt }));
  const msgPlatformSignature = await platform.sign("countersign", countersignDigest);

  const closeStatement = {
    v: 1 as const,
    type: "openglass.close" as const,
    sessionId,
    headSeq: 1,
    headHash: msgHash,
    closedAt: iso(3000),
  };
  const closeSignature = sign(initiator.privateKey, A.kid, "close", sha256(canonicalizeToBytes(closeStatement)));

  const evidence = {
    v: 1 as const,
    type: "openglass.evidence" as const,
    offer,
    offerSignature,
    accept,
    acceptSignature,
    genesisHash,
    genesisSignature,
    messages: [
      {
        envelope,
        hash: msgHash,
        signature: msgSignature,
        receivedAt,
        platformSignature: msgPlatformSignature,
        payload,
      },
    ],
    close: { statement: closeStatement, signature: closeSignature },
  };
  const evidenceSha256 = hex(sha256(canonicalizeToBytes(evidence)));
  const issuedAt = iso(4000);

  const statement = {
    v: 1 as const,
    type: "openglass.record" as const,
    recordId,
    sessionId,
    mode: "relay" as const,
    purpose: offer.purpose,
    participants: [
      { role: "initiator" as const, agentId: A.agentId, ownerId: ownerA, kid: A.kid, publicKey: A.publicKey },
      { role: "counterparty" as const, agentId: B.agentId, ownerId: ownerB, kid: B.kid, publicKey: B.publicKey },
    ],
    genesisHash,
    headSeq: 1,
    headHash: msgHash,
    messageCount: 1,
    activatedAt: accept.acceptedAt,
    closedAt: closeStatement.closedAt,
    closeReason: "agent_closed" as const,
    closedBy: A.agentId,
    evidenceSha256,
    issuedAt,
  };
  const statementHash = hex(sha256(canonicalizeToBytes(statement)));
  const recordPlatformSignature = await platform.sign("record", hexToBytes(statementHash));

  const bundle: RecordBundle = {
    v: 1,
    type: "openglass.bundle",
    record: { statement, statementHash, platformSignature: recordPlatformSignature },
    evidence,
    platformKeys: [
      {
        kid: platformKid,
        alg: "ECDSA_P256_SHA256",
        publicKey: await platform.publicKeyBase64Url(),
        validFrom: iso(-86_400_000),
        validUntil: null,
      },
    ],
  };

  opts.tamper?.(bundle);
  return { bundle, platformKid };
}

function generateEcP256Pem(): { privateKey: string } {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey };
}
