import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("GET /health", () => {
  it("returns 200", async () => {
    const res = await buildServer({ apiInternalUrl: "http://127.0.0.1:1" }).inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("/mcp-public transport routes", () => {
  // GET is probed without `text/event-stream` in Accept: with it, stateless mode would
  // open a long-lived SSE stream rather than answer.
  it("answers GET and DELETE the same way /mcp does", async () => {
    const app = buildServer({ apiInternalUrl: "http://127.0.0.1:1" });
    for (const [method, accept] of [["GET", "application/json"], ["DELETE", "application/json, text/event-stream"]] as const) {
      const full = await app.inject({ method, url: "/mcp", headers: { accept } });
      const pub = await app.inject({ method, url: "/mcp-public", headers: { accept } });
      expect(pub.statusCode).toBe(full.statusCode);
      expect(pub.statusCode).not.toBe(404);
    }
  });
});

describe("GET /.well-known/openai-apps-challenge", () => {
  it("serves exactly the token as text/plain, no auth", async () => {
    const res = await buildServer({ apiInternalUrl: "http://127.0.0.1:1" }).inject({ method: "GET", url: "/.well-known/openai-apps-challenge" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toBe("jDkvAc4OAVw7wT_YUSIZplZ87Pho_rhzxQAwvFPW6Zo");
  });
});
