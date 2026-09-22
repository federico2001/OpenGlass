import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../packages/db/test/testDb.js";
import { buildHealthServer } from "../src/health.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});

describe("GET /health", () => {
  it("returns 200 when Mongo answers", async () => {
    const res = await buildHealthServer(() => t.db.command({ ping: 1 })).inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 503 when Mongo doesn't", async () => {
    const res = await buildHealthServer(() => Promise.reject(new Error("down"))).inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "fail", checks: { mongo: "fail" } });
  });
});
