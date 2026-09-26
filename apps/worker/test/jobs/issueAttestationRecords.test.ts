import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  attestationsRepository,
  base64UrlEncode,
  canonicalizeToBytes,
  findRecordBySession,
  sha256,
  signEd25519,
  sigInput,
  verifyBundle,
  type RecordBundle,
} from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { openTestS3 } from "../../../../packages/db/test/testS3.js";
import { issueAttestationRecords } from "../../src/jobs/issueAttestationRecords.js";
import { buildActiveAttestation, testSigner } from "../helpers.js";

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
  for (const c of ["agents", "owners", "attestations", "messages", "records"]) await t.db.collection(c).deleteMany({});
});

async function fetchBundle(signer: Awaited<ReturnType<typeof testSigner>>, attestationId: string): Promise<RecordBundle> {
  const record = await findRecordBySession(t.db, attestationId);
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

describe("issueAttestationRecords", () => {
  it("issues an independently-verifiable record for an agent-closed attestation", async () => {
    const signer = testSigner();
    const { attestation, attestor } = await buildActiveAttestation(t.db, { signer, eventCount: 2 });
    const closeStatement = {
      v: 1 as const,
      type: "openglass.close" as const,
      sessionId: attestation._id,
      headSeq: attestation.head.seq,
      headHash: attestation.head.hash,
      closedAt: new Date().toISOString(),
    };
    const closeSignature = {
      alg: "Ed25519" as const,
      kid: attestor.kid,
      sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(closeStatement))), attestor.privateKey)),
    };
    await attestationsRepository(t.db).update(attestation._id, {
      status: "closing",
      closing: { reason: "agent_closed", requestedBy: attestor.agentId, statement: closeStatement, signature: closeSignature, requestedAt: new Date() },
    });

    const result = await issueAttestationRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer });
    expect(result.issued).toBe(1);
    expect(result.skipped).toBe(0);

    const updated = await attestationsRepository(t.db).findById(attestation._id);
    expect(updated!.status).toBe("closed");
    expect(updated!.recordId).toBeTruthy();

    const bundle = await fetchBundle(signer, attestation._id);
    expect(bundle.evidence.messages).toHaveLength(2);
    expect(bundle.evidence.offer).toBeNull();
    expect(bundle.evidence.open).not.toBeNull();
    expect(bundle.record.statement.kind).toBe("attestation");
    expect(bundle.record.statement.participants).toEqual([
      { role: "attestor", agentId: attestor.agentId, ownerId: attestor.ownerId, kid: attestor.kid, publicKey: attestor.publicKey },
    ]);
    expect(bundle.record.statement.closeReason).toBe("agent_closed");
    expect(bundle.record.statement.closedBy).toBe(attestor.agentId);

    const verification = verifyBundle(bundle, bundle.platformKeys);
    expect(verification.errors).toEqual([]);
    expect(verification.valid).toBe(true);

    // re-running the sweep must be a no-op — the attestation is no longer `closing`.
    const again = await issueAttestationRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer });
    expect(again.issued).toBe(0);
  });

  it("issues a valid record for a worker-initiated close (idle timeout, no agent signature)", async () => {
    const signer = testSigner();
    const { attestation } = await buildActiveAttestation(t.db, { signer, eventCount: 1 });
    await attestationsRepository(t.db).update(attestation._id, {
      status: "closing",
      closing: { reason: "idle_timeout", requestedBy: null, statement: null, signature: null, requestedAt: new Date() },
    });

    const result = await issueAttestationRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer });
    expect(result.issued).toBe(1);

    const bundle = await fetchBundle(signer, attestation._id);
    expect(bundle.evidence.close).toBeNull();
    expect(bundle.record.statement.closedBy).toBeNull();
    expect(bundle.record.statement.closeReason).toBe("idle_timeout");

    const verification = verifyBundle(bundle, bundle.platformKeys);
    expect(verification.errors).toEqual([]);
    expect(verification.valid).toBe(true);
  });
});
