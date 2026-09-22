import { describe, expect, it } from "vitest";
import { GET } from "../app/health/route.js";

describe("GET /health (web)", () => {
  it("returns 200", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
