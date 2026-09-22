import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../packages/db/test/testDb.js";
import { buildServer } from "../src/server.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});

describe("GET /health", () => {
  it("returns 200 when Mongo and S3 are reachable", async () => {
    const app = buildServer({ healthChecks: { mongo: () => t.db.command({ ping: 1 }), s3: async () => {} } });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", checks: { mongo: "ok", s3: "ok" } });
  });

  it("returns 503 and names the failing dependency", async () => {
    const app = buildServer({
      healthChecks: { mongo: () => t.db.command({ ping: 1 }), s3: async () => Promise.reject(new Error("NoSuchBucket")) },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "fail", checks: { mongo: "ok", s3: "fail" } });
  });

  it("returns 503 when a check hangs", async () => {
    const app = buildServer({ healthChecks: { mongo: () => new Promise(() => {}) } });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.mongo).toBe("fail");
  }, 10_000);
});
