import { GetObjectCommand } from "@aws-sdk/client-s3";
import { decryptPayload, findRecordById, type RecordDoc } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { canAccessRecord } from "../domain/access.js";
import { trustedPlatformKeys } from "../domain/platformKeys.js";
import { sendError } from "../errors.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import type { ServerDeps } from "../server.js";

/** `sealed`-visibility records give a receipt-only response until both owners consent to
 * unseal, or either disputes (docs/SPEC.md §13.2) — deliberately narrower than `recordView`/
 * the full bundle: no `purpose` (the one statement field most likely to carry real content)
 * and no `evidence` at all. `shared`/`private` records, and a `sealed` one that's since been
 * unsealed/disputed, never take this path. */
function isSealedAndUnresolved(record: RecordDoc): boolean {
  return record.visibility === "sealed" && record.sealedState?.status !== "unsealed" && record.sealedState?.status !== "disputed";
}

function receiptView(record: RecordDoc) {
  const s = record.statement;
  return {
    v: 1,
    type: "openglass.receipt",
    recordId: record._id,
    statementHash: record.statementHash,
    platformSignature: record.platformSignature,
    genesisHash: s.genesisHash,
    headSeq: s.headSeq,
    headHash: s.headHash,
    messageCount: s.messageCount,
    evidenceSha256: s.evidenceSha256,
    participants: s.participants,
    activatedAt: s.activatedAt,
    closedAt: s.closedAt,
    issuedAt: s.issuedAt,
    sealedState: record.sealedState
      ? {
          status: record.sealedState.status,
          requestedBy: record.sealedState.requestedBy,
          approvals: record.sealedState.approvals,
        }
      : null,
  };
}

function recordView(doc: RecordDoc) {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    statement: doc.statement,
    statementHash: doc.statementHash,
    platformSignature: doc.platformSignature,
    evidence: { sha256: doc.evidence.sha256, bytes: doc.evidence.bytes },
    createdAt: doc.createdAt.toISOString(),
  };
}

export function registerRecordsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Params: { recordId: string } }>(
    "/v1/records/:recordId",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !canAccessRecord(record, req)) return sendError(reply, 404, "not_found", "Record not found");
      return { record: recordView(record) };
    },
  );

  app.get<{ Params: { recordId: string } }>(
    "/v1/records/:recordId/bundle",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !canAccessRecord(record, req)) return sendError(reply, 404, "not_found", "Record not found");

      if (isSealedAndUnresolved(record)) return receiptView(record);

      const obj = await deps.s3.send(new GetObjectCommand({ Bucket: deps.s3Bucket, Key: record.evidence.s3Key }));
      const evidenceBytes = await obj.Body!.transformToByteArray();
      const evidence = JSON.parse(Buffer.from(evidenceBytes).toString("utf8"));

      const bundle: Record<string, unknown> = {
        v: 1,
        type: "openglass.bundle",
        record: { statement: record.statement, statementHash: record.statementHash, platformSignature: record.platformSignature },
        evidence,
        platformKeys: await trustedPlatformKeys(deps.signer, deps.platformKeyValidFrom),
      };

      // `visibility: "private"` (docs/SPEC.md §13.3): `evidence` above is always exactly
      // what was signed — untouched ciphertext, `contentState: "encrypted"` and all, so
      // `evidenceSha256`/the platform's signature keep verifying against it. This is a
      // *separate*, additive, non-verifiable convenience field decrypted fresh on every
      // request for an already-authorized viewer (canAccessRecord above), never persisted
      // and never folded into `evidence` itself.
      if (record.visibility === "private" && record.encryption) {
        if (record.encryption.shredded || !record.encryption.dataKeyCiphertext) {
          bundle.contentDeleted = true;
        } else if (deps.contentEncryption) {
          try {
            const dataKey = await deps.contentEncryption.encryptor.decryptDataKey(record.encryption.dataKeyCiphertext);
            const decryptedPayloads: Record<number, unknown> = {};
            for (const m of evidence.messages ?? []) {
              if (m.contentState === "encrypted") decryptedPayloads[m.envelope.seq] = decryptPayload(dataKey, m.payload);
            }
            bundle.decryptedPayloads = decryptedPayloads;
          } catch (err) {
            req.log.warn({ err, recordId: record._id }, "failed to decrypt private record content for display");
          }
        }
      }

      reply.header("Content-Disposition", `attachment; filename="${record._id}.openglass.json"`);
      return bundle;
    },
  );
}
