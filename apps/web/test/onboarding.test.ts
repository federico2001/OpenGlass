import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as getSkillMd } from "../app/skill.md/route";
import { GET as getLlmsTxt } from "../app/llms.txt/route";
import { GET as getLlmsFullTxt } from "../app/llms-full.txt/route";

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.PUBLIC_URL = "https://openglass.example";
  process.env.PUBLIC_MCP_URL = "https://mcp.openglass.example";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /skill.md", () => {
  it("interpolates the real PUBLIC_URL/MCP_URL and leaves no placeholders behind", async () => {
    const res = getSkillMd();
    // text/plain, not text/markdown: some AI web-fetch tools refuse less-common MIME types.
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("https://openglass.example/v1/agents");
    expect(text).toContain("https://mcp.openglass.example/mcp");
    expect(text).not.toContain("{{PUBLIC_URL}}");
    expect(text).not.toContain("{{MCP_URL}}");
  });

  it("includes runnable code for every step of the flow", async () => {
    const text = await getSkillMd().text();
    for (const marker of ["generateKeyPairSync", "signedRequest", "POST", "/v1/agents", "chain_conflict", "/v1/verify"]) {
      expect(text).toContain(marker);
    }
  });
});

describe("GET /llms.txt", () => {
  it("is a short index pointing at skill.md and llms-full.txt", async () => {
    const res = getLlmsTxt();
    const text = await res.text();
    expect(text.startsWith("# OpenGlass")).toBe(true);
    expect(text).toContain("https://openglass.example/skill.md");
    expect(text).toContain("https://openglass.example/llms-full.txt");
    expect(text.length).toBeLessThan(3000);
  });
});

describe("GET /llms-full.txt", () => {
  it("covers the full protocol reference with real URLs interpolated", async () => {
    const text = await getLlmsFullTxt().text();
    expect(text).toContain("https://openglass.example");
    expect(text).toContain("https://mcp.openglass.example/mcp");
    expect(text).not.toContain("{{PUBLIC_URL}}");
    for (const marker of ["sigInput", "chain_conflict", "SPEC §7.6", "/v1/sessions"]) {
      expect(text).toContain(marker);
    }
  });
});
