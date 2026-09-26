import { GetObjectCommand, GetObjectRetentionCommand, PutObjectRetentionCommand } from "@aws-sdk/client-s3";
import { findRecordById, type RecordDoc } from "@openglass/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { canAccessRecord } from "../domain/access.js";
import { EXTEND_RETENTION_PRICE_CENTS, PDF_PRICE_CENTS, VERIFIED_BADGE_PRICE_CENTS, formatUsd, premiumRoutePriceCents, wouldExceedSpendLimit } from "../domain/spendLimits.js";
import { sendError } from "../errors.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import { requireClaimed } from "../plugins/requireClaimed.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { agentFullView } from "../domain/agentViews.js";
import { agentsRepository } from "@openglass/db";
import type { ServerDeps } from "../server.js";

const EXTENDED_RETENTION_YEARS = 10;

/** Matches the two record-scoped premium routes and captures `recordId`. */
export const RECORD_SCOPED_PREMIUM_ROUTE = /^\/v1\/premium\/records\/([^/?]+)\/(?:pdf|extend-retention)(?:$|\?)/;

/**
 * x402's `paymentMiddleware` runs in `onRequest` and gates purely on the route pattern —
 * it has no idea whether the record behind `:recordId` actually exists, so a nonexistent
 * one would still prompt for payment before either handler's own 404 check ever runs.
 * Registered before `paymentMiddleware` in server.ts (Fastify hooks run in registration
 * order), this short-circuits with 404 first, so an agent is never asked to pay for a
 * record that was never there. It deliberately checks existence only, not access — the
 * handlers still 404 on a record that exists but isn't the caller's, matching SPEC §8.1's
 * "don't confirm existence" rule for anyone who isn't a participant.
 */
export function requireExistingRecordForPremiumRoutes(db: Db): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const match = RECORD_SCOPED_PREMIUM_ROUTE.exec(req.raw.url ?? "");
    if (!match) return;
    const record = await findRecordById(db, decodeURIComponent(match[1]!));
    if (!record) return sendError(reply, 404, "not_found", "Record not found");
  };
}

/**
 * An owner can cap how much an agent spends on its own x402 premium purchases. That has to
 * be enforced before payment settles (x402's `paymentMiddleware` runs in `onRequest`, ahead
 * of any of this route module's own `preHandler` auth, so by the time a handler below could
 * check anything the money has already moved) — which means this hook, registered before
 * `paymentMiddleware`, has to identify the caller before the real signed-request
 * verification in `verifyAgentRequest`/`verifyAgentOrOwner` gets a chance to run.
 *
 * It does that by reading the claimed `OG-Agent` header directly, without verifying the
 * request's signature. That's safe *only* for this narrow purpose: the header is never
 * trusted for anything but a spend-limit lookup, and every one of these routes still runs
 * full signature verification afterward — spoofing this header can, at worst, cause an
 * unrelated request to be wrongly rate-gated against someone else's limit, never let
 * anyone spend as an agent they can't cryptographically prove they are. A request with no
 * `OG-Agent` header (an owner calling extend-retention/pdf with their own cookie, not an
 * agent's key) isn't governed by any agent's spend limit and passes through untouched.
 */
export function requireWithinSpendLimit(db: Db): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const agents = agentsRepository(db);
  return async (req, reply) => {
    const priceCents = premiumRoutePriceCents(req.method, req.raw.url ?? "");
    if (priceCents === null) return;
    const header = req.headers["og-agent"];
    const agentId = Array.isArray(header) ? header[0] : header;
    if (!agentId) return;
    const agent = await agents.findById(agentId);
    if (!agent) return; // an unknown agent id: let the real auth check produce the right error
    if (wouldExceedSpendLimit(agent, priceCents)) {
      return sendError(
        reply,
        403,
        "spend_limit_exceeded",
        `This agent's owner-set spend limit (${formatUsd(agent.spendLimitUsdCents!)}) would be exceeded by this ${formatUsd(priceCents)} purchase`,
        { spendLimitUsdCents: agent.spendLimitUsdCents, totalSpendUsdCents: agent.totalSpendUsdCents ?? 0, priceCents },
      );
    }
  };
}

/** Adds `priceCents` to the agent's tracked lifetime spend — called once payment has
 * cleared and the handler is actually about to perform the paid action. Only ever called
 * with a verified agent identity (`req.agent`, set by `verifyAgentRequest`/
 * `verifyAgentOrOwner`), never for an owner-authenticated call — owners aren't governed by
 * a spend limit on themselves. */
async function recordAgentSpend(db: Db, agentId: string, currentTotalCents: number, priceCents: number): Promise<void> {
  await agentsRepository(db).update(agentId, { totalSpendUsdCents: currentTotalCents + priceCents });
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
      const before = req.agent!.doc;
      const updated = await agents.update(before._id, {
        verifiedBadge: true,
        totalSpendUsdCents: (before.totalSpendUsdCents ?? 0) + VERIFIED_BADGE_PRICE_CENTS,
      });
      return { agent: agentFullView(updated!) };
    },
  );

  app.post<{ Params: { recordId: string } }>(
    "/v1/premium/records/:recordId/extend-retention",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const record = await findRecordById(deps.db, req.params.recordId);
      if (!record || !canAccessRecord(record, req)) return sendError(reply, 404, "not_found", "Record not found");

      // S3 Object Lock never lets an object's retention Mode change once set — COMPLIANCE
      // can't be downgraded to GOVERNANCE by anyone, and even GOVERNANCE can only be
      // widened (a longer RetainUntilDate), not switched. So this always reuses whatever
      // mode the object already carries; it never decides the mode itself. The only object
      // with no existing retention is one uploaded before Object Lock was enabled on the
      // bucket, which can't happen for records this platform issued itself.
      const current = await deps.s3.send(
        new GetObjectRetentionCommand({ Bucket: deps.s3Bucket, Key: record.evidence.s3Key }),
      ).catch(() => null);
      const mode = current?.Retention?.Mode ?? deps.objectLockMode ?? "COMPLIANCE";

      const retainUntil = new Date();
      retainUntil.setFullYear(retainUntil.getFullYear() + EXTENDED_RETENTION_YEARS);
      await deps.s3.send(
        new PutObjectRetentionCommand({
          Bucket: deps.s3Bucket,
          Key: record.evidence.s3Key,
          Retention: { Mode: mode, RetainUntilDate: retainUntil },
          BypassGovernanceRetention: false,
        }),
      );
      if (req.agent) await recordAgentSpend(deps.db, req.agent.doc._id, req.agent.doc.totalSpendUsdCents ?? 0, EXTEND_RETENTION_PRICE_CENTS);
      return { recordId: record._id, retentionMode: mode, retainUntilDate: retainUntil.toISOString() };
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
      if (req.agent) await recordAgentSpend(deps.db, req.agent.doc._id, req.agent.doc.totalSpendUsdCents ?? 0, PDF_PRICE_CENTS);
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
