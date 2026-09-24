import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  base64UrlEncode,
  canonicalizeToBytes,
  findRecordBySession,
  sessionsRepository,
  sha256,
  signEd25519,
  sigInput,
  verifyBundle,
  type RecordBundle,
} from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { openTestS3 } from "../../../../packages/db/test/testS3.js";
import { issueRecords } from "../../src/jobs/issueRecords.js";
import { createCapturingMailer } from "../../src/mailer.js";
import { buildActiveSession, testSigner } from "../helpers.js";

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
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "records"]) await t.db.collection(c).deleteMany({});
});

async function fetchBundle(signer: Awaited<ReturnType<typeof testSigner>>, sessionId: string): Promise<RecordBundle> {
  const record = await findRecordBySession(t.db, sessionId);
  expect(record).not.toBeNull();
  const obj = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: record!.evidence.s3Key }));
  const evidence = JSON.parse(Buffer.from(await obj.Body!.transformToByteArray()).toString("utf8"));
  return {
    v: 1,
    type: "openglass.bundle",
    record: { statement: record!.statement, statementHash: record!.statementHash, platformSignature: record!.platformSignature },
    evidence,
    platformKeys: [{ kid: signer.kid, alg: signer.alg, publicKey: await signer.publicKeyBase64Url(), validFrom: "1970-01-01T00:00:00.000Z", validUntil: null }],
  };
}

describe("issueRecords", () => {
  it("issues an independently-verifiable record for an agent-closed session", async () => {
    const signer = testSigner();
    const { session, initiator } = await buildActiveSession(t.db, { signer, messageCount: 2 });
    const closeStatement = {
      v: 1 as const,
      type: "openglass.close" as const,
      sessionId: session._id,
      headSeq: session.head.seq,
      headHash: session.head.hash,
      closedAt: new Date().toISOString(),
    };
    const closeSignature = {
      alg: "Ed25519" as const,
      kid: initiator.kid,
      sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(closeStatement))), initiator.privateKey)),
    };
    await sessionsRepository(t.db).update(session._id, {
      status: "closing",
      closing: { reason: "agent_closed", requestedBy: initiator.agentId, statement: closeStatement, signature: closeSignature, requestedAt: new Date() },
    });

    const mailer = createCapturingMailer();
    const result = await issueRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer, mailer, publicUrl: "https://localhost" });
    expect(result.issued).toBe(1);
    expect(result.skipped).toBe(0);

    const updatedSession = await sessionsRepository(t.db).findById(session._id);
    expect(updatedSession!.status).toBe("closed");
    expect(updatedSession!.recordId).toBeTruthy();

    const bundle = await fetchBundle(signer, session._id);
    expect(bundle.evidence.messages).toHaveLength(2);
    expect(bundle.record.statement.closeReason).toBe("agent_closed");
    expect(bundle.record.statement.closedBy).toBe(initiator.agentId);

    const verification = verifyBundle(bundle, bundle.platformKeys);
    expect(verification.errors).toEqual([]);
    expect(verification.valid).toBe(true);

    // owners get emailed (both participants have emailOnRecord: true by default)
    expect(mailer.sent.length).toBeGreaterThanOrEqual(1);

    // re-running the sweep must be a no-op — the session is no longer `closing`.
    const again = await issueRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer, mailer, publicUrl: "https://localhost" });
    expect(again.issued).toBe(0);
  });

  it("issues a valid record for a worker-initiated close (no agent signature)", async () => {
    const signer = testSigner();
    const { session } = await buildActiveSession(t.db, { signer, messageCount: 1 });
    await sessionsRepository(t.db).update(session._id, {
      status: "closing",
      closing: { reason: "idle_timeout", requestedBy: null, statement: null, signature: null, requestedAt: new Date() },
    });

    const mailer = createCapturingMailer();
    const result = await issueRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer, mailer, publicUrl: "https://localhost" });
    expect(result.issued).toBe(1);

    const bundle = await fetchBundle(signer, session._id);
    expect(bundle.evidence.close).toBeNull();
    expect(bundle.record.statement.closedBy).toBeNull();
    expect(bundle.record.statement.closeReason).toBe("idle_timeout");

    const verification = verifyBundle(bundle, bundle.platformKeys);
    expect(verification.errors).toEqual([]);
    expect(verification.valid).toBe(true);
  });
});
