import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildTestBundle } from "../../../../packages/db/test/crypto/buildTestBundle.js";
import { buildServer } from "../../src/server.js";
import { testServerDeps } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

describe("POST /v1/verify", () => {
  it("rejects a well-formed bundle signed by a platform key the server doesn't trust", async () => {
    // buildTestBundle signs with its own throwaway platform key, not this server's — so
    // this exercises the route's wiring (Zod parse, verifyBundle call, response shape)
    // without needing a real record from the worker (M5), which owns the happy path.
    const { bundle } = await buildTestBundle();
    const res = await app().inject({ method: "POST", url: "/v1/verify", payload: bundle });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
    expect(res.json().recordId).toBe(bundle.record.statement.recordId);
    expect(res.json().sessionId).toBe(bundle.record.statement.sessionId);
    const codes = res.json().errors.map((e: { code: string }) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["record_signature", "genesis_signature"]));
  });

  it("rejects a malformed body with 400 validation_failed", async () => {
    const res = await app().inject({ method: "POST", url: "/v1/verify", payload: { not: "a bundle" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});
