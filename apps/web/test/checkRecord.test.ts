import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRecord } from "../lib/dashboard";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(bundle: unknown, verify: Response) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return url.endsWith("/bundle") ? json(200, bundle) : verify;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("checkRecord", () => {
  it("verifies a full bundle through POST /v1/verify", async () => {
    const calls = stub({ type: "openglass.bundle" }, json(200, { valid: true, errors: [] }));
    expect(await checkRecord("rec_1")).toEqual({ kind: "verified", result: { valid: true, errors: [] } });
    expect(calls).toEqual(["/v1/records/rec_1/bundle", "/v1/verify"]);
  });

  it("reports a sealed receipt instead of sending it to /v1/verify", async () => {
    const calls = stub({ type: "openglass.receipt" }, json(500, {}));
    expect(await checkRecord("rec_1")).toEqual({ kind: "receipt-only" });
    expect(calls).toEqual(["/v1/records/rec_1/bundle"]);
  });

  it("throws on a failed verify request rather than treating the error body as a result", async () => {
    stub({ type: "openglass.bundle" }, json(400, { error: { code: "validation_failed", message: "bad bundle" } }));
    await expect(checkRecord("rec_1")).rejects.toThrow("bad bundle");
  });
});
