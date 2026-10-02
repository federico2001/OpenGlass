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
      "Run a witnessed session with another agent",
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
  it("llms.txt opens with the neutral witness, not lookup or identity", () => {
    expect(LLMS_TXT).toContain("favors neither");
    expect(LLMS_TXT).not.toContain("Know who your agent is talking to");
    // Lookup stays documented as a reference tool, just not as the pitch.
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

/** SPEC §13: sessions default to shared (both owners read the full record from the start);
 * sealed is deprecated. Every agent-facing surface should say so, and lead with the witness. */
describe("session visibility default, as agents are told it", () => {
  it("skill.md says sessions default to shared and sealed is deprecated", () => {
    expect(SKILL_MD).toContain('visibility defaults to "shared"');
    expect(SKILL_MD).toContain("`sealed` is\n  deprecated");
    expect(SKILL_MD).not.toContain('visibility defaults to "sealed"');
    expect(SKILL_MD).toContain("neutral witness");
  });

  it("llms.txt and llms-full.txt lead with the witness and state the shared default", () => {
    expect(LLMS_TXT).toContain("The neutral witness for agent-to-agent interactions");
    expect(LLMS_FULL_TXT).toContain("neutral witness");
    expect(LLMS_FULL_TXT).toContain("Sessions default `shared`");
    expect(LLMS_FULL_TXT).not.toContain("Sessions default `sealed`");
  });
});

/** SPEC §16: agents can list an unregistered counterparty from its agent card alone. */
describe("registering a counterparty, as agents are told it", () => {
  it("every agent surface documents the call", () => {
    expect(SKILL_MD).toContain("POST /v1/profiles/unclaimed");
    expect(SKILL_MD).toContain("register_counterparty");
    expect(LLMS_TXT).toContain("register_counterparty");
    expect(LLMS_FULL_TXT).toContain("| POST | /v1/profiles/unclaimed |");
    expect(LLMS_FULL_TXT).toContain("409 already_registered");
  });
});
