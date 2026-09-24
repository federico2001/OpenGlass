import { GetObjectCommand, GetObjectRetentionCommand, PutObjectRetentionCommand } from "@aws-sdk/client-s3";
import { findRecordById, type RecordDoc } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { sendError } from "../errors.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import { requireClaimed } from "../plugins/requireClaimed.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { agentFullView } from "../domain/agentViews.js";
import { agentsRepository } from "@openglass/db";
import type { ServerDeps } from "../server.js";

const EXTENDED_RETENTION_YEARS = 10;

function canAccessRecord(record: RecordDoc, req: { agent?: { doc: { _id: string } }; owner?: { _id: string } }): boolean {
  if (req.agent && record.participantAgentIds.includes(req.agent.doc._id)) return true;
  if (req.owner && record.participantOwnerIds.includes(req.owner._id)) return true;
  return false;
}

/**
 * The actual business logic behind each `/v1/premium/*` route. These are registered as
 * ordinary Fastify routes — payment gating itself lives entirely in the `@x402/fastify`
 * `paymentMiddleware` hooks registered in `server.ts`, which run in Fastify's `onRequest`
 * phase (before these handlers, and before the `preHandler` auth below) and reject an
 * unpaid request with 402 before it ever reaches here.
 */
export function registerPremiumRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const agents = agentsRepository(deps.db);

  app.post(
    "/v1/premium/agents/me/verified-badge",
    { preHandler: [verifyAgentRequest(deps.db), requireClaimed] },
    async (req) => {
      const updated = await agents.update(req.agent!.doc._id, { verifiedBadge: true });
      return { agent: agentFullView(updated!) };
    },
  );

  app.post<{ Params: { recordId: string } }>(
    "/v1/premium/records/:recordId/extend-retention",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !canAccessRecord(record, req)) return sendError(reply, 404, "not_found", "Record not found");

      const retainUntil = new Date();
      retainUntil.setFullYear(retainUntil.getFullYear() + EXTENDED_RETENTION_YEARS);
      await deps.s3.send(
        new PutObjectRetentionCommand({
          Bucket: deps.s3Bucket,
          Key: record.evidence.s3Key,
          Retention: { Mode: "GOVERNANCE", RetainUntilDate: retainUntil },
          BypassGovernanceRetention: false,
        }),
      );
      return { recordId: record._id, retentionMode: "GOVERNANCE", retainUntilDate: retainUntil.toISOString() };
    },
  );

  app.get<{ Params: { recordId: string } }>(
    "/v1/premium/records/:recordId/retention",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !canAccessRecord(record, req)) return sendError(reply, 404, "not_found", "Record not found");
      try {
        const result = await deps.s3.send(new GetObjectRetentionCommand({ Bucket: deps.s3Bucket, Key: record.evidence.s3Key }));
        return {
          recordId: record._id,
          retentionMode: result.Retention?.Mode ?? null,
          retainUntilDate: result.Retention?.RetainUntilDate?.toISOString() ?? null,
        };
      } catch {
        return { recordId: record._id, retentionMode: null, retainUntilDate: null };
      }
    },
  );

  app.get<{ Params: { recordId: string } }>(
    "/v1/premium/records/:recordId/pdf",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !canAccessRecord(record, req)) return sendError(reply, 404, "not_found", "Record not found");

      const obj = await deps.s3.send(new GetObjectCommand({ Bucket: deps.s3Bucket, Key: record.evidence.s3Key }));
      const evidenceBytes = await obj.Body!.transformToByteArray();
      const evidence = JSON.parse(Buffer.from(evidenceBytes).toString("utf8"));

      const pdfBytes = await buildRecordPdf(record, evidence);
      reply.header("content-type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="${record._id}.pdf"`);
      return reply.send(Buffer.from(pdfBytes));
    },
  );
}

async function buildRecordPdf(record: RecordDoc, evidence: { messages: unknown[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]); // US Letter
  const margin = 56;
  let y = 792 - margin;

  const line = (text: string, opts: { size?: number; bold?: boolean; gap?: number } = {}) => {
    const size = opts.size ?? 11;
    page.drawText(text, { x: margin, y, size, font: opts.bold ? bold : font, color: rgb(0.07, 0.09, 0.09) });
    y -= (opts.gap ?? size + 6);
  };

  line("OpenGlass — Witnessed Session Record", { size: 18, bold: true, gap: 30 });
  line(`Record ${record._id}`, { bold: true });
  line(`Session ${record.statement.sessionId}`);
  line(`Mode: ${record.statement.mode}    Messages: ${record.statement.messageCount}`);
  line(`Activated: ${record.statement.activatedAt}`);
  line(`Closed: ${record.statement.closedAt} (${record.statement.closeReason})`, { gap: 24 });

  line("Participants", { size: 13, bold: true, gap: 20 });
  for (const p of record.statement.participants) {
    line(`${p.role}: ${p.agentId} (key ${p.kid})`);
  }
  y -= 10;

  line("Verification", { size: 13, bold: true, gap: 20 });
  line(`Genesis hash: ${record.statement.genesisHash}`);
  line(`Head hash: ${record.statement.headHash ?? "(no messages)"}`);
  line(`Evidence sha256: ${record.statement.evidenceSha256}`);
  line(`Platform signature (${record.platformSignature.alg}, ${record.platformSignature.kid}): ${record.platformSignature.sig.slice(0, 48)}…`);
  y -= 10;

  line(
    `This PDF is a human-readable summary. The signed record bundle (GET /v1/records/${record._id}/bundle)`,
    { size: 9 },
  );
  line("is the authoritative artifact — verify it independently with POST /v1/verify or any OpenGlass SDK.", { size: 9, gap: 20 });
  line(`Generated ${new Date().toISOString()} · ${evidence.messages.length} message(s) in evidence.`, { size: 9 });

  return doc.save();
}
