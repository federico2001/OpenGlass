import Fastify from "fastify";
import { insertRecord, type RecordDoc } from "@openglass/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildTestBundle } from "../../../../packages/db/test/crypto/buildTestBundle.js";
import { requireExistingRecordForPremiumRoutes } from "../../src/routes/premium.js";

/**
 * Regression test for the "PDF endpoint charges for a record that doesn't exist" bug: the
 * hook that runs before x402's paymentMiddleware (see server.ts) must 404 a nonexistent
 * recordId, and must never touch a request for a record that does exist or a path outside
 * the two record-scoped premium routes. Exercised directly, without a real x402
 * resourceServer, for the same reason sessionLifecycle.test.ts's `premiumApp` skips real
 * payment — that needs a funded on-chain wallet (see scripts/x402-test-agent.ts).
 */
describe("requireExistingRecordForPremiumRoutes", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>;
  let recordId: string;

  beforeAll(async () => {
    t = await openTestDb();
    const { bundle } = await buildTestBundle();
    recordId = bundle.record.statement.recordId;
    const doc: RecordDoc = {
      _id: recordId,
      sessionId: bundle.record.statement.sessionId,
      statement: bundle.record.statement,
      statementHash: bundle.record.statementHash,
      platformSignature: bundle.record.platformSignature,
      evidence: { s3Key: `records/${recordId}/evidence.json`, sha256: bundle.record.statement.evidenceSha256, bytes: 1234 },
      participantAgentIds: bundle.record.statement.participants.map((p) => p.agentId),
      participantOwnerIds: bundle.record.statement.participants.map((p) => p.ownerId),
      createdAt: new Date(),
    };
    await insertRecord(t.db, doc);
  });

  afterAll(() => t.cleanup());

  function buildGuardedApp() {
    const app = Fastify({ logger: false });
    app.addHook("onRequest", requireExistingRecordForPremiumRoutes(t.db));
    app.get("/v1/premium/records/:recordId/pdf", async () => ({ reached: "pdf" }));
    app.post("/v1/premium/records/:recordId/extend-retention", async () => ({ reached: "extend-retention" }));
    app.post("/v1/premium/agents/me/verified-badge", async () => ({ reached: "badge" }));
    return app;
  }

  it("404s a nonexistent record before the handler runs, for both record-scoped routes", async () => {
    const app = buildGuardedApp();
    const pdfRes = await app.inject({ method: "GET", url: "/v1/premium/records/rec_doesnotexist/pdf" });
    expect(pdfRes.statusCode).toBe(404);
    expect(pdfRes.json().error.code).toBe("not_found");

    const extendRes = await app.inject({ method: "POST", url: "/v1/premium/records/rec_doesnotexist/extend-retention" });
    expect(extendRes.statusCode).toBe(404);
    expect(extendRes.json().error.code).toBe("not_found");
  });

  it("passes an existing record through to the handler untouched", async () => {
    const app = buildGuardedApp();
    const res = await app.inject({ method: "GET", url: `/v1/premium/records/${recordId}/pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reached: "pdf" });
  });

  it("doesn't touch premium routes that aren't record-scoped", async () => {
    const app = buildGuardedApp();
    const res = await app.inject({ method: "POST", url: "/v1/premium/agents/me/verified-badge" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reached: "badge" });
  });
});
