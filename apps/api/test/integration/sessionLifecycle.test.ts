import {
  base64UrlEncode,
  canonicalizeToBytes,
  newId,
  sha256,
  signEd25519,
  sigInput,
  verifyBundle,
  type RecordBundle,
} from "@openglass/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { openTestS3 } from "../../../../packages/db/test/testS3.js";
import { issueRecords } from "../../../worker/src/jobs/issueRecords.js";
import { createCapturingMailer as createWorkerMailer } from "../../../worker/src/mailer.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
  buildOffer,
  claimAgentDirectly,
  insertTestOwner,
  signedRequestHeaders,
  testIdentity,
  testServerDeps,
  type TestAgentIdentity,
} from "../helpers.js";

/**
 * Phase 1 sign-off (see plan): register two agents, claim them, offer and accept a
 * session, exchange messages, close it, have the worker issue the record, then fetch and
 * independently verify the bundle — through the real HTTP API end to end, not repository
 * calls. A tampering case at the end proves verification actually catches a break.
 *
 * `app`/`signer` are built ONCE for the whole test (mirroring how apps/api/src/index.ts
 * builds the server once for the process's lifetime) — building a fresh signer per
 * request, like other route-test files' `app()` helper does, would sign different parts
 * of this session's chain with different unrelated keys, which is fine for tests that
 * never re-verify crypto end-to-end but breaks the one thing this test exists to check.
 */

let t: Awaited<ReturnType<typeof openTestDb>>;
let s3: Awaited<ReturnType<typeof openTestS3>>;
let app: ReturnType<typeof buildServer>;
let signer: ReturnType<typeof testServerDeps>["signer"];

beforeAll(async () => {
  t = await openTestDb();
  s3 = await openTestS3();
  const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
  signer = deps.signer;
  app = buildServer({ ...deps, healthChecks: {} });
});
afterAll(async () => {
  await t.cleanup();
  await s3.cleanup();
});

async function registerAndClaim(name: string): Promise<TestAgentIdentity> {
  const identity = testIdentity(`ph_${name}`, `ph_key_${name}`);
  const body = { name, description: "Phase 1 sign-off agent", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  expect(res.statusCode).toBe(201);
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}-${newId("own").slice(-8)}@example.com`);
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return identity;
}

function signClose(sessionId: string, headSeq: number, headHash: string | null, identity: TestAgentIdentity) {
  const statement = { v: 1 as const, type: "openglass.close" as const, sessionId, headSeq, headHash, closedAt: new Date().toISOString() };
  const signature = {
    alg: "Ed25519" as const,
    kid: identity.kid,
    sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), identity.privateKey)),
  };
  return { statement, signature };
}

describe("Phase 1 sign-off: full two-agent session lifecycle", () => {
  it("register -> claim -> offer -> accept -> messages -> close -> record -> verify", async () => {
    const alice = await registerAndClaim(`alice_${newId("agt").slice(-6)}`);
    const bob = await registerAndClaim(`bob_${newId("agt").slice(-6)}`);

    // offer + accept
    const { offer, offerSignature } = buildOffer({
      sessionId: newId("ses"),
      initiator: alice,
      counterpartyAgentId: bob.agentId,
      purpose: "Negotiate delivery date for PO 4411",
    });
    const createBody = { offer, offerSignature };
    const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: alice });
    const createRes = await app.inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
    expect(createRes.statusCode).toBe(201);
    const inviteId = createRes.json().invite.id as string;

    const { accept, signature: acceptSig } = buildAccept({ offer, counterparty: bob });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const acceptBody = { accept, signature: acceptSig };
    const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: bob });
    const acceptRes = await app.inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().session.status).toBe("active");

    // three chained messages, alternating senders
    let prevHash = acceptRes.json().session.genesisHash as string;
    const senders = [alice, bob, alice];
    for (let i = 0; i < senders.length; i++) {
      const seq = i + 1;
      const sender = senders[i]!;
      const payload = { text: `message ${seq}` };
      const payloadHash = sha256(canonicalizeToBytes(payload)).toString("hex");
      const envelope = {
        v: 1 as const,
        type: "openglass.message" as const,
        sessionId: offer.sessionId,
        seq,
        prevHash,
        sender: { agentId: sender.agentId, kid: sender.kid },
        contentType: "application/json",
        payloadHash,
        sentAt: new Date().toISOString(),
      };
      const hashBytes = sha256(Buffer.concat([Buffer.from(prevHash, "hex"), canonicalizeToBytes(envelope)]));
      const hash = hashBytes.toString("hex");
      const msgSignature = { alg: "Ed25519" as const, kid: sender.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), sender.privateKey)) };
      const msgBody = { envelope, hash, signature: msgSignature, payload };
      const msgPath = `/v1/sessions/${offer.sessionId}/messages`;
      const msgHeaders = signedRequestHeaders({ method: "POST", path: msgPath, body: msgBody, identity: sender });
      const msgRes = await app.inject({ method: "POST", url: msgPath, headers: msgHeaders, payload: msgBody });
      expect(msgRes.statusCode).toBe(201);
      prevHash = hash;
    }

    // close, signed by Alice at the current head (seq 3)
    const { statement, signature: closeSig } = signClose(offer.sessionId, 3, prevHash, alice);
    const closePath = `/v1/sessions/${offer.sessionId}/close`;
    const closeBody = { statement, signature: closeSig };
    const closeHeaders = signedRequestHeaders({ method: "POST", path: closePath, body: closeBody, identity: alice });
    const closeRes = await app.inject({ method: "POST", url: closePath, headers: closeHeaders, payload: closeBody });
    expect(closeRes.statusCode).toBe(202);
    expect(closeRes.json().session.status).toBe("closing");

    // the worker (not HTTP — it has no routes of its own) picks up the closing session,
    // using the SAME signer the API server used to countersign everything above.
    const workerMailer = createWorkerMailer();
    const issueResult = await issueRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer, mailer: workerMailer, publicUrl: "https://localhost" });
    expect(issueResult.issued).toBe(1);

    const sessionPath = `/v1/sessions/${offer.sessionId}`;
    const sessionAfter = await app.inject({ method: "GET", url: sessionPath, headers: signedRequestHeaders({ method: "GET", path: sessionPath, identity: alice }) });
    expect(sessionAfter.json().session.status).toBe("closed");
    const recordId = sessionAfter.json().session.recordId as string;
    expect(recordId).toBeTruthy();

    // fetch the bundle through the real HTTP API and verify it independently, client-side
    const bundlePath = `/v1/records/${recordId}/bundle`;
    const bundleRes = await app.inject({ method: "GET", url: bundlePath, headers: signedRequestHeaders({ method: "GET", path: bundlePath, identity: alice }) });
    expect(bundleRes.statusCode).toBe(200);
    const bundle = bundleRes.json() as RecordBundle;
    expect(bundle.evidence.messages).toHaveLength(3);

    const clientSideResult = verifyBundle(bundle, bundle.platformKeys);
    expect(clientSideResult.errors).toEqual([]);
    expect(clientSideResult.valid).toBe(true);

    // and through the platform's own public /v1/verify endpoint
    const verifyRes = await app.inject({ method: "POST", url: "/v1/verify", payload: bundle });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().valid).toBe(true);
    expect(verifyRes.json().errors).toEqual([]);

    // tamper one field and confirm verification actually catches it
    const tampered: RecordBundle = JSON.parse(JSON.stringify(bundle));
    tampered.evidence.messages[1]!.envelope.payloadHash = "0".repeat(64);
    const tamperedRes = await app.inject({ method: "POST", url: "/v1/verify", payload: tampered });
    expect(tamperedRes.json().valid).toBe(false);
    expect(tamperedRes.json().errors.map((e: { code: string }) => e.code)).toContain("payload_hash");
  });
});
