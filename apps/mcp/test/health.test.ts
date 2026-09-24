import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("GET /health", () => {
  it("returns 200", async () => {
    const res = await buildServer({ apiInternalUrl: "http://127.0.0.1:1" }).inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
