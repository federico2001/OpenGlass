import { base64UrlEncode, canonicalizeToBytes, findRecordById, insertRecord, newId, sha256, signEd25519, sigInput, verifyBundle, type RecordBundle, type RecordDoc } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { openTestS3 } from "../../../../packages/db/test/testS3.js";
import { issueRecords } from "../../../worker/src/jobs/issueRecords.js";
import { shredExpiredPrivateRecords } from "../../../worker/src/jobs/shredExpiredPrivateRecords.js";
import { createCapturingMailer as createWorkerMailer } from "../../../worker/src/mailer.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
  buildOffer,
  claimAgentDirectly,
  createOwnerSessionCookie,
  insertTestOwner,
  signedRequestHeaders,
  testContentEncryptionDeps,
  testIdentity,
  testServerDeps,
  type TestAgentIdentity,
} from "../helpers.js";

/**
 * Realignment R1 (docs/SPEC.md §13): end-to-end coverage for `visibility` across the full
 * session lifecycle — through the real HTTP API and the worker's real issuance job, the
 * same style as test/integration/sessionLifecycle.test.ts, since both sealing's receipt-
 * gating and private's encrypt-at-issuance behavior only make sense as a whole pipeline,
 * not as isolated unit tests of one layer.
 */

let t: Awaited<ReturnType<typeof openTestDb>>;
let s3: Awaited<ReturnType<typeof openTestS3>>;

beforeAll(async () => {
  t = await openTestDb();
  s3 = await openTestS3();
});
afterAll(async () => {
  await t.cleanup();
  await s3.cleanup();
});
beforeEach(async () => {
  // Each test in this file registers fresh agents/owners through the real HTTP routes
  // (registration is rate-limited per IP, and app.inject() reuses the same fake IP across
  // calls) — reset between tests so one test's registrations don't count against the
  // next's limit, the same convention sessions.test.ts/attestations.test.ts use.
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "records", "request_nonces", "rate_limits", "web_sessions"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function signClose(sessionId: string, headSeq: number, headHash: string | null, identity: TestAgentIdentity) {
  const statement = { v: 1 as const, type: "openglass.close" as const, sessionId, headSeq, headHash, closedAt: new Date().toISOString() };
  const signature = {
    alg: "Ed25519" as const,
    kid: identity.kid,
    sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), identity.privateKey)),
  };
  return { statement, signature };
}

/** Registers+claims two fresh agents under two fresh owners, runs a full offer -> accept ->
 * one message -> close -> issueRecords cycle, and returns everything a test needs to poke
 * at the resulting record. `visibility`/`contentEncryption` are the two R1 knobs under test. */
async function buildClosedSessionRecord(opts: {
  app: ReturnType<typeof buildServer>;
  signer: ReturnType<typeof testServerDeps>["signer"];
  visibility?: "private" | "sealed" | "shared";
  contentEncryption: ReturnType<typeof testServerDeps>["contentEncryption"];
}) {
  const { app, signer } = opts;
  const suffix = newId("ses").slice(-8);

  async function registerAndClaim(name: string) {
    const identity = testIdentity(`${name}_${suffix}`, `${name}_key_${suffix}`);
    const body = { name: identity.agentId, description: "R1 test agent", publicKey: identity.publicKey };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
    const res = await app.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    identity.agentId = res.json().agent.id;
    identity.kid = res.json().agent.keys[0].kid;
    const owner = await insertTestOwner(t.db, `${name}-${suffix}@example.com`);
    await claimAgentDirectly(t.db, identity.agentId, owner._id);
    return { identity, ownerId: owner._id as string };
  }

  const alice = await registerAndClaim("alice");
  const bob = await registerAndClaim("bob");

  const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator: alice.identity, counterpartyAgentId: bob.identity.agentId });
  const createBody = { offer, offerSignature, ...(opts.visibility ? { visibility: opts.visibility } : {}) };
  const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: alice.identity });
  const createRes = await app.inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
  expect(createRes.statusCode).toBe(201);
  const inviteId = createRes.json().invite.id as string;

  const { accept, signature: acceptSig } = buildAccept({ offer, counterparty: bob.identity });
  const acceptPath = `/v1/invites/${inviteId}/accept`;
  const acceptBody = { accept, signature: acceptSig };
  const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: bob.identity });
  const acceptRes = await app.inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });
  expect(acceptRes.statusCode).toBe(200);
  const genesisHash = acceptRes.json().session.genesisHash as string;

  const payload = { text: "hello from R1 test" };
  const payloadHash = sha256(canonicalizeToBytes(payload)).toString("hex");
  const envelope = {
    v: 1 as const,
    type: "openglass.message" as const,
    sessionId: offer.sessionId,
    seq: 1,
    prevHash: genesisHash,
    sender: { agentId: alice.identity.agentId, kid: alice.identity.kid },
    contentType: "application/json",
    payloadHash,
    sentAt: new Date().toISOString(),
  };
  const hashBytes = sha256(Buffer.concat([Buffer.from(genesisHash, "hex"), canonicalizeToBytes(envelope)]));
  const hash = hashBytes.toString("hex");
  const msgSignature = { alg: "Ed25519" as const, kid: alice.identity.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), alice.identity.privateKey)) };
  const msgBody = { envelope, hash, signature: msgSignature, payload };
  const msgPath = `/v1/sessions/${offer.sessionId}/messages`;
  const msgHeaders = signedRequestHeaders({ method: "POST", path: msgPath, body: msgBody, identity: alice.identity });
  expect((await app.inject({ method: "POST", url: msgPath, headers: msgHeaders, payload: msgBody })).statusCode).toBe(201);

  const { statement, signature: closeSig } = signClose(offer.sessionId, 1, hash, alice.identity);
  const closePath = `/v1/sessions/${offer.sessionId}/close`;
  const closeBody = { statement, signature: closeSig };
  const closeHeaders = signedRequestHeaders({ method: "POST", path: closePath, body: closeBody, identity: alice.identity });
  expect((await app.inject({ method: "POST", url: closePath, headers: closeHeaders, payload: closeBody })).statusCode).toBe(202);

  const issueResult = await issueRecords({
    db: t.db,
    s3: s3.client,
    s3Bucket: s3.bucket,
    signer,
    mailer: createWorkerMailer(),
    publicUrl: "https://localhost",
    contentEncryption: opts.contentEncryption
      ? { encryptor: opts.contentEncryption.encryptor, kmsKeyId: opts.contentEncryption.kmsKeyId, defaultRetentionDays: opts.contentEncryption.defaultRetentionDays }
      : null,
  });
  expect(issueResult.issued).toBe(1);

  const sessionPath = `/v1/sessions/${offer.sessionId}`;
  const sessionAfter = await app.inject({ method: "GET", url: sessionPath, headers: signedRequestHeaders({ method: "GET", path: sessionPath, identity: alice.identity }) });
  const recordId = sessionAfter.json().session.recordId as string;
  expect(recordId).toBeTruthy();

  return { alice, bob, recordId };
}

async function getBundle(app: ReturnType<typeof buildServer>, recordId: string, ownerCookie: string) {
  return app.inject({ method: "GET", url: `/v1/records/${recordId}/bundle`, headers: { cookie: ownerCookie } });
}

describe("visibility: sealed — receipt-only until mutual unseal or dispute", () => {
  it("gives a receipt-only response until both owners consent, then the full bundle", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {} });
    const { alice, bob, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, visibility: "sealed", contentEncryption: null });

    const aliceCookie = await createOwnerSessionCookie(t.db, alice.ownerId);
    const bobCookie = await createOwnerSessionCookie(t.db, bob.ownerId);

    const sealedBundle = await getBundle(app, recordId, aliceCookie);
    expect(sealedBundle.statusCode).toBe(200);
    expect(sealedBundle.json().type).toBe("openglass.receipt");
    expect(sealedBundle.json().evidence).toBeUndefined();
    expect(sealedBundle.json().sealedState.status).toBe("sealed");

    const requestRes = await app.inject({
      method: "POST",
      url: `/v1/records/${recordId}/unseal-request`,
      headers: { cookie: aliceCookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(requestRes.statusCode).toBe(200);
    expect(requestRes.json().sealedState.status).toBe("unseal_requested");

    const stillSealed = await getBundle(app, recordId, bobCookie);
    expect(stillSealed.json().type).toBe("openglass.receipt");

    const approveRes = await app.inject({
      method: "POST",
      url: `/v1/records/${recordId}/unseal-approve`,
      headers: { cookie: bobCookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().sealedState.status).toBe("unsealed");

    const fullBundle = await getBundle(app, recordId, bobCookie);
    expect(fullBundle.statusCode).toBe(200);
    expect(fullBundle.json().type).toBe("openglass.bundle");
    expect(fullBundle.json().evidence.messages).toHaveLength(1);
    const result = verifyBundle(fullBundle.json() as RecordBundle, fullBundle.json().platformKeys);
    expect(result.valid).toBe(true);
  });

  it("a dispute force-unseals immediately without the other owner's consent", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {} });
    const { bob, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, visibility: "sealed", contentEncryption: null });
    const bobCookie = await createOwnerSessionCookie(t.db, bob.ownerId);

    const disputeRes = await app.inject({
      method: "POST",
      url: `/v1/records/${recordId}/dispute`,
      headers: { cookie: bobCookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(disputeRes.statusCode).toBe(200);
    expect(disputeRes.json().sealedState.status).toBe("disputed");

    const bundle = await getBundle(app, recordId, bobCookie);
    expect(bundle.json().type).toBe("openglass.bundle");
  });

  it("a second dispute is rejected", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {} });
    const { alice, bob, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, visibility: "sealed", contentEncryption: null });
    const headers = (cookie: string) => ({ cookie, origin: "https://localhost", "content-type": "application/json" });
    const first = await app.inject({ method: "POST", url: `/v1/records/${recordId}/dispute`, headers: headers(await createOwnerSessionCookie(t.db, bob.ownerId)) });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/v1/records/${recordId}/dispute`, headers: headers(await createOwnerSessionCookie(t.db, alice.ownerId)) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("already_disputed");
  });

  it("rejects unseal actions from an owner who isn't a participant", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {} });
    const { recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, visibility: "sealed", contentEncryption: null });
    const outsider = await insertTestOwner(t.db, `outsider-${newId("own").slice(-8)}@example.com`);
    const outsiderCookie = await createOwnerSessionCookie(t.db, outsider._id);

    const res = await app.inject({
      method: "POST",
      url: `/v1/records/${recordId}/unseal-request`,
      headers: { cookie: outsiderCookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("visibility: shared (the session default) — both owners read the full record from the start", () => {
  it("defaults a session to shared and gives both owners the full bundle immediately", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {} });
    const { alice, bob, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, contentEncryption: null });
    for (const ownerId of [alice.ownerId, bob.ownerId]) {
      const bundle = await getBundle(app, recordId, await createOwnerSessionCookie(t.db, ownerId));
      expect(bundle.statusCode).toBe(200);
      expect(bundle.json().type).toBe("openglass.bundle");
      expect(bundle.json().record.statement.visibility).toBe("shared");
    }
  });

  it("a dispute flags the record, opens nothing, and counts on lookup", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {} });
    const { alice, bob, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, contentEncryption: null });
    const bobCookie = await createOwnerSessionCookie(t.db, bob.ownerId);

    const disputeRes = await app.inject({
      method: "POST",
      url: `/v1/records/${recordId}/dispute`,
      headers: { cookie: bobCookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(disputeRes.statusCode).toBe(200);
    expect(disputeRes.json()).toMatchObject({ visibility: "shared", dispute: { disputedBy: bob.ownerId }, sealedState: null });

    const record = await app.inject({ method: "GET", url: `/v1/records/${recordId}`, headers: { cookie: bobCookie } });
    expect(record.json().record.dispute.disputedBy).toBe(bob.ownerId);

    const lookup = await app.inject({ method: "GET", url: `/v1/lookup?agentId=${alice.identity.agentId}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().openDisputesCount).toBe(1);
  });
});

describe("disputes are between two sides", () => {
  it("refuses to dispute a one-party (attestation-shaped) record", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {} });
    const { bob, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, contentEncryption: null });
    const source = await findRecordById(t.db, recordId);
    const onePartyId = newId("rec");
    await insertRecord(t.db, {
      ...source!,
      _id: onePartyId,
      sessionId: newId("ses"),
      participantOwnerIds: [bob.ownerId],
      participantAgentIds: [source!.participantAgentIds[1]!],
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/records/${onePartyId}/dispute`,
      headers: { cookie: await createOwnerSessionCookie(t.db, bob.ownerId), origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("not_disputable");
  });
});

describe("visibility: private — encrypted at rest, immediately readable by participant owners", () => {
  it("encrypts relay payloads before issuance and decrypts them back for an authorized owner", async () => {
    const contentEncryption = testContentEncryptionDeps();
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {}, contentEncryption });
    const { alice, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, visibility: "private", contentEncryption });

    const aliceCookie = await createOwnerSessionCookie(t.db, alice.ownerId);
    const bundleRes = await getBundle(app, recordId, aliceCookie);
    expect(bundleRes.statusCode).toBe(200);
    const body = bundleRes.json();
    expect(body.record.statement.visibility).toBe("private");
    expect(body.evidence.messages[0].contentState).toBe("encrypted");
    expect(body.evidence.messages[0].payload.type).toBe("openglass.encrypted-payload");
    expect(body.decryptedPayloads["1"]).toEqual({ text: "hello from R1 test" });

    // the bundle still verifies structurally exactly as issued — decryptedPayloads is a
    // pure addition, never a substitute for the signed/hashed evidence.
    const result = verifyBundle(body as RecordBundle, body.platformKeys);
    expect(result.valid).toBe(true);
    expect(result.info).toEqual([{ code: "content_encrypted", seq: 1, message: "content_encrypted" }]);
  });

  it("gracefully degrades to sealed (no encryption) end to end when content encryption isn't configured", async () => {
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket }); // contentEncryption: null by default
    const app = buildServer({ ...deps, healthChecks: {} });
    const { alice, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, visibility: "private", contentEncryption: null });

    const aliceCookie = await createOwnerSessionCookie(t.db, alice.ownerId);
    const bundleRes = await getBundle(app, recordId, aliceCookie);
    expect(bundleRes.json().type).toBe("openglass.receipt"); // sealed, not private
  });

  it("crypto-shredding via the retention sweep makes content permanently unreadable while the record stays verifiable", async () => {
    const contentEncryption = testContentEncryptionDeps();
    const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
    const app = buildServer({ ...deps, healthChecks: {}, contentEncryption });
    const { alice, recordId } = await buildClosedSessionRecord({ app, signer: deps.signer, visibility: "private", contentEncryption });

    // force the record's retention into the past, as if its window had already elapsed
    await t.db.collection<RecordDoc>("records").updateOne({ _id: recordId }, { $set: { "retention.expiresAt": new Date(0) } });
    const shredResult = await shredExpiredPrivateRecords({ db: t.db });
    expect(shredResult.shredded).toBe(1);

    const aliceCookie = await createOwnerSessionCookie(t.db, alice.ownerId);
    const bundleRes = await getBundle(app, recordId, aliceCookie);
    expect(bundleRes.statusCode).toBe(200);
    const body = bundleRes.json();
    expect(body.contentDeleted).toBe(true);
    expect(body.record.statementHash).toBeTruthy(); // the record itself is still there and verifiable

    const result = verifyBundle(body as RecordBundle, body.platformKeys);
    expect(result.valid).toBe(true); // shredding never touches evidence/statement/signatures
  });
});
