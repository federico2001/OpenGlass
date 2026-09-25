import { GetObjectCommand } from "@aws-sdk/client-s3";
import { findRecordById, type RecordDoc } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { canAccessRecord } from "../domain/access.js";
import { trustedPlatformKeys } from "../domain/platformKeys.js";
import { sendError } from "../errors.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import type { ServerDeps } from "../server.js";

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

      const obj = await deps.s3.send(new GetObjectCommand({ Bucket: deps.s3Bucket, Key: record.evidence.s3Key }));
      const evidenceBytes = await obj.Body!.transformToByteArray();
      const evidence = JSON.parse(Buffer.from(evidenceBytes).toString("utf8"));

      const bundle = {
        v: 1,
        type: "openglass.bundle",
        record: { statement: record.statement, statementHash: record.statementHash, platformSignature: record.platformSignature },
        evidence,
        platformKeys: await trustedPlatformKeys(deps.signer, deps.platformKeyValidFrom),
      };
      reply.header("Content-Disposition", `attachment; filename="${record._id}.openglass.json"`);
      return bundle;
    },
  );
}
