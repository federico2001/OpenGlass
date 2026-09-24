/**
 * Dev-only script (not shipped in the published package — see `files` in package.json).
 * Builds a fully real, fully valid `RecordBundle` using `packages/db`'s actual production
 * crypto code (not a hand-typed fixture), and writes it to `fixtures/vectors.json`. This
 * SDK's own test suite then checks that its independently ported `canonicalize`/`sha256`/
 * `verifyBundle` reproduce the exact same hashes and accept the exact same bundle — the
 * cross-implementation drift check the plan calls for. Re-run after any change to
 * `packages/db/src/crypto/*` or the protocol shapes: `pnpm generate:vectors`.
 */
import { writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import {
  base64UrlEncode,
  canonicalize,
  canonicalizeToBytes,
  generateEd25519KeyPair,
  hex,
  hexToBytes,
  LocalSigner,
  sha256,
  signEd25519,
  sigInput,
  type RecordBundle,
} from "../../packages/db/dist/index.js";

async function main() {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString();

  const initiator = generateEd25519KeyPair();
  const counterparty = generateEd25519KeyPair();
  const A = { agentId: "agt_01J8Z3K4M5N6P7Q8R9S0T1V2WA", kid: "key_01J8Z3K4M5N6P7Q8R9S0T1V2WB", publicKey: base64UrlEncode(initiator.publicKey) };
  const B = { agentId: "agt_01J8Z3K4M5N6P7Q8R9S0T1V2WC", kid: "key_01J8Z3K4M5N6P7Q8R9S0T1V2WD", publicKey: base64UrlEncode(counterparty.publicKey) };
  const ownerA = "own_01J8Z3K4M5N6P7Q8R9S0T1V2WE";
  const ownerB = "own_01J8Z3K4M5N6P7Q8R9S0T1V2WF";
  const sessionId = "ses_01J8Z3K4M5N6P7Q8R9S0T1V2WG";
  const recordId = "rec_01J8Z3K4M5N6P7Q8R9S0T1V2WH";

  const platformKid = "plat_vectors";
  const { privateKey: platformPem } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const platform = new LocalSigner(platformKid, platformPem as string);

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
    purpose: "Cross-implementation test vector for sdk-js.",
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

  const payload = { text: "Hello — let's get started.", n: 42, nested: { ok: true } };
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
    messages: [{ envelope, hash: msgHash, signature: msgSignature, receivedAt, platformSignature: msgPlatformSignature, payload }],
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
      { kid: platformKid, alg: "ECDSA_P256_SHA256", publicKey: await platform.publicKeyBase64Url(), validFrom: iso(-86_400_000), validUntil: null },
    ],
  };

  const vectors = {
    generatedAt: new Date().toISOString(),
    generatedBy: "packages/db (production crypto), see scripts/generate-vectors.ts",
    canonicalization: [
      { input: { z: 1, a: 2, nested: { b: [3, 2, 1], m: -0 }, s: "quotes \" and \\ and /" }, expected: canonicalize({ z: 1, a: 2, nested: { b: [3, 2, 1], m: -0 }, s: "quotes \" and \\ and /" }) },
      { input: offer, expected: canonicalize(offer), expectedHex: hex(sha256(canonicalizeToBytes(offer))), description: "sha256(canonicalize(offer)) — the offer hash" },
      // Number formatting is the sharpest cross-language edge in JCS: it mandates
      // ECMAScript's Number::toString, which other languages don't produce by default
      // (different exponential-notation thresholds, exponent formatting, trailing zeros).
      // Every SDK port's canonicalize() must match these exactly or a message payload
      // containing any of these values would hash differently across implementations.
      { input: { n: 0 }, expected: canonicalize({ n: 0 }) },
      { input: { n: -0 }, expected: canonicalize({ n: -0 }) },
      { input: { n: 1 }, expected: canonicalize({ n: 1 }) },
      { input: { n: -1 }, expected: canonicalize({ n: -1 }) },
      { input: { n: 42 }, expected: canonicalize({ n: 42 }) },
      { input: { n: 100 }, expected: canonicalize({ n: 100 }) },
      { input: { n: 0.1 }, expected: canonicalize({ n: 0.1 }) },
      { input: { n: 0.5 }, expected: canonicalize({ n: 0.5 }) },
      { input: { n: 1.5 }, expected: canonicalize({ n: 1.5 }) },
      { input: { n: -1.5 }, expected: canonicalize({ n: -1.5 }) },
      { input: { n: 3.14159 }, expected: canonicalize({ n: 3.14159 }) },
      { input: { n: 1e21 }, expected: canonicalize({ n: 1e21 }) },
      { input: { n: 1e20 }, expected: canonicalize({ n: 1e20 }) },
      { input: { n: 1e30 }, expected: canonicalize({ n: 1e30 }) },
      { input: { n: 2e-3 }, expected: canonicalize({ n: 2e-3 }) },
      { input: { n: 1e-7 }, expected: canonicalize({ n: 1e-7 }) },
      { input: { n: 1e-6 }, expected: canonicalize({ n: 1e-6 }) },
      { input: { n: 123456789012345 }, expected: canonicalize({ n: 123456789012345 }) },
      { input: { n: 9007199254740991 }, expected: canonicalize({ n: 9007199254740991 }), description: "Number.MAX_SAFE_INTEGER" },
      { input: { n: 333333333.33333329 }, expected: canonicalize({ n: 333333333.33333329 }), description: "rounds to nearest representable double" },
      { input: { n: 100000000000000000000 }, expected: canonicalize({ n: 100000000000000000000 }) },
      { input: { s: "unicode: café 日本語 😀" }, expected: canonicalize({ s: "unicode: café 日本語 😀" }), description: "non-ASCII + astral-plane emoji (surrogate pair)" },
      { input: { s: "  control chars" }, expected: canonicalize({ s: "  control chars" }) },
      { input: [], expected: canonicalize([]) },
      { input: {}, expected: canonicalize({}) },
      { input: null, expected: canonicalize(null) },
      { input: [1, "two", null, true, false, { three: 3 }], expected: canonicalize([1, "two", null, true, false, { three: 3 }]) },
    ],
    validBundle: bundle,
    // A bundle a naive/independent port might accept even though it's tampered — a good
    // canary for "did we actually re-derive the genesis hash, or just trust bundle.evidence.genesisHash".
    tamperedBundle: { ...bundle, evidence: { ...bundle.evidence, offer: { ...bundle.evidence.offer, purpose: "Tampered after signing." } } },
  };

  writeFileSync(new URL("../fixtures/vectors.json", import.meta.url), JSON.stringify(vectors, null, 2) + "\n");
  console.log("Wrote fixtures/vectors.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
