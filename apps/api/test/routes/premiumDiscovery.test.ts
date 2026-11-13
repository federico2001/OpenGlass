import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { testServerDeps } from "../helpers.js";

/**
 * x402 Bazaar discovery metadata on the three premium routes (domain/x402Discovery.ts).
 * Uses the real `@x402/fastify` paymentMiddleware and a real `x402ResourceServer` built the
 * same way domain/x402.ts builds it. Only the facilitator is an in-process stand-in that
 * answers `getSupported` (no network) and refuses to verify or settle: an unpaid request
 * never reaches the facilitator, which is all these tests exercise. A real paid round trip
 * needs a funded wallet (scripts/x402-test-agent.ts).
 */
const NETWORK = "eip155:8453" as const;
const PAY_TO = "0x7507e37Cb19E91445797a4D82915CE2016d69087";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const offlineFacilitator: FacilitatorClient = {
  getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} }),
  verify: async () => {
    throw new Error("test facilitator never verifies");
  },
  settle: async () => {
    throw new Error("test facilitator never settles");
  },
};

let t: Awaited<ReturnType<typeof openTestDb>>;
let resourceServer: x402ResourceServer;

beforeAll(async () => {
  t = await openTestDb();
  resourceServer = new x402ResourceServer(offlineFacilitator)
    .register(NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  await resourceServer.initialize();
});
afterAll(async () => {
  await t.cleanup();
});

function app() {
  return buildServer({
    ...testServerDeps(t),
    healthChecks: {},
    x402: { resourceServer, payTo: PAY_TO, network: NETWORK },
  });
}

function decodePaymentRequired(header: unknown) {
  expect(typeof header).toBe("string");
  return JSON.parse(Buffer.from(header as string, "base64").toString("utf8"));
}

// Record-scoped routes 404 a nonexistent record before payment (premiumPaymentGuard.test.ts),
// so they're probed with a record that does exist.
async function insertRecordFixture(): Promise<string> {
  const { insertRecord } = await import("@openglass/db");
  const { buildTestBundle } = await import("../../../../packages/db/test/crypto/buildTestBundle.js");
  const { bundle } = await buildTestBundle();
  const s = bundle.record.statement;
  await insertRecord(t.db, {
    _id: s.recordId,
    sessionId: s.sessionId,
    statement: s,
    statementHash: bundle.record.statementHash,
    platformSignature: bundle.record.platformSignature,
    evidence: { s3Key: `records/${s.recordId}/evidence.json`, sha256: s.evidenceSha256, bytes: 1234 },
    participantAgentIds: s.participants.map((p) => p.agentId),
    participantOwnerIds: s.participants.map((p) => p.ownerId),
    createdAt: new Date(),
  });
  return s.recordId;
}

describe("x402 Bazaar discovery on /v1/premium/*", () => {
  it("verified-badge: 402 carries the bazaar extension, accepts unchanged", async () => {
    const res = await app().inject({ method: "POST", url: "/v1/premium/agents/me/verified-badge" });
    expect(res.statusCode).toBe(402);
    const pr = decodePaymentRequired(res.headers["payment-required"]);

    expect(pr.x402Version).toBe(2);
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, amount: "1000000", asset: USDC_BASE, payTo: PAY_TO });

    expect(pr.resource).toMatchObject({ serviceName: "OpenGlass", tags: ["agents", "verification", "records", "a2a"] });
    expect(pr.resource.iconUrl).toBe("https://localhost/icon.svg");

    const info = pr.extensions.bazaar.info;
    expect(info.input).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
    expect(info.output.example.agent.verifiedBadge).toBe(true);
    expect(pr.extensions.bazaar.schema).toBeDefined();
  });

  it("record routes: method, path param and routeTemplate, prices unchanged", async () => {
    const recordId = await insertRecordFixture();

    const extend = await app().inject({ method: "POST", url: `/v1/premium/records/${recordId}/extend-retention` });
    expect(extend.statusCode).toBe(402);
    const extendPr = decodePaymentRequired(extend.headers["payment-required"]);
    expect(extendPr.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, amount: "500000", asset: USDC_BASE });
    expect(extendPr.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "POST", pathParams: { recordId } });
    expect(extendPr.extensions.bazaar.routeTemplate).toBe("/v1/premium/records/:recordId/extend-retention");

    const pdf = await app().inject({ method: "GET", url: `/v1/premium/records/${recordId}/pdf` });
    expect(pdf.statusCode).toBe(402);
    const pdfPr = decodePaymentRequired(pdf.headers["payment-required"]);
    expect(pdfPr.accepts[0]).toMatchObject({ scheme: "exact", network: NETWORK, amount: "250000", asset: USDC_BASE });
    expect(pdfPr.resource.mimeType).toBe("application/pdf");
    expect(pdfPr.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "GET", pathParams: { recordId } });
    expect(pdfPr.extensions.bazaar.routeTemplate).toBe("/v1/premium/records/:recordId/pdf");
  });

  it("still 404s a nonexistent record before asking for payment", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/premium/records/rec_doesnotexist/pdf" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["payment-required"]).toBeUndefined();
  });
});
