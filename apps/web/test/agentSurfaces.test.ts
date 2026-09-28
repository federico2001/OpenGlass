import { describe, expect, it } from "vitest";
import { SKILL_MD } from "../app/skill.md/content";
import { CONTENT as LLMS_TXT } from "../app/llms.txt/content";
import { CONTENT as LLMS_FULL_TXT } from "../app/llms-full.txt/content";

/** Realignment R6: every surface an agent reads should lead with lookup, in the same
 * five-step order, and none of them should still be advertising tools/routes that don't
 * exist or have been renamed. */
describe("skill.md", () => {
  it("leads with lookup, in R6's five-step order", () => {
    expect(SKILL_MD).toContain("# OpenGlass: check who you're talking to");
    const steps = [...SKILL_MD.matchAll(/^## Step \d — (.+)$/gm)].map((m) => m[1]);
    expect(steps).toEqual([
      "Look up a counterparty",
      "Register and get claimed",
      "Attest a high-risk action (private by default)",
      "Run a sealed session with another agent",
      "Verify",
    ]);
  });

  it("explains visibility and retention in plain language", () => {
    expect(SKILL_MD).toContain("Visibility and retention, plainly");
    expect(SKILL_MD).toContain("cryptographically shredded");
  });

  it("mentions only MCP tools that actually exist", () => {
    expect(SKILL_MD).toContain("lookup_agent");
    expect(SKILL_MD).toContain("open_attestation");
    // Guards against drift if a tool is ever renamed without updating this doc.
    expect(SKILL_MD).not.toContain("attest_action");
  });

  it("has no unsubstituted {{...}} placeholders once real values are filled in", () => {
    const body = SKILL_MD.replaceAll("{{PUBLIC_URL}}", "https://openglass.glass").replaceAll("{{MCP_URL}}", "https://mcp.openglass.glass");
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe("llms.txt / llms-full.txt", () => {
  it("llms.txt opens with the lookup-first description", () => {
    expect(LLMS_TXT).toContain("Know who your agent is talking to");
    expect(LLMS_TXT).toContain("lookup_agent");
  });

  it("llms-full.txt documents GET /v1/lookup and the R4 owner-oversight routes", () => {
    expect(LLMS_FULL_TXT).toContain("## Looking up a counterparty");
    expect(LLMS_FULL_TXT).toContain("| GET | /v1/lookup |");
    expect(LLMS_FULL_TXT).toContain("/v1/owner/agents/{id}/visibility-default");
    expect(LLMS_FULL_TXT).toContain("/v1/owner/agents/{id}/access-log");
  });

  it("neither file has unsubstituted placeholders once filled in", () => {
    for (const content of [LLMS_TXT, LLMS_FULL_TXT]) {
      const body = content.replaceAll("{{PUBLIC_URL}}", "https://openglass.glass").replaceAll("{{MCP_URL}}", "https://mcp.openglass.glass");
      expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });
});
