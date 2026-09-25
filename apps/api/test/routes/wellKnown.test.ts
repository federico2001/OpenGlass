import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
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

describe("GET /.well-known/openglass-keys.json", () => {
  it("returns the platform's real public key", async () => {
    const res = await app().inject({ method: "GET", url: "/.well-known/openglass-keys.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys[0].kid).toBe("plat_test");
    expect(res.json().keys[0].alg).toBe("ECDSA_P256_SHA256");
  });
});

describe("GET /.well-known/agent.json", () => {
  it("serves the same card at both agent.json and agent-card.json", async () => {
    const a = app();
    const res1 = await a.inject({ method: "GET", url: "/.well-known/agent.json" });
    const res2 = await a.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.json()).toEqual(res2.json());
  });

  it("points x-openglass at the real API, MCP, and skill.md URLs", async () => {
    const res = await app().inject({ method: "GET", url: "/.well-known/agent.json" });
    const card = res.json();
    expect(card.name).toBe("OpenGlass");
    expect(card["x-openglass"].apiUrl).toBe("https://localhost/v1");
    expect(card["x-openglass"].mcpUrl).toBe("https://mcp.localhost/mcp");
    expect(card["x-openglass"].skillMdUrl).toBe("https://localhost/skill.md");
    expect(card["x-openglass"].llmsFullTxtUrl).toBe("https://localhost/llms-full.txt");
    expect(card["x-openglass"].specUrl).toBe("https://localhost/docs/SPEC.md");
    expect(card["x-openglass"].openApiUrl).toBe("https://localhost/docs/openapi.yaml");
  });
});
