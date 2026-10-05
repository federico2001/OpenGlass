import { describe, expect, it } from "vitest";
import { renderText, witnessLine, type Report } from "../src/report.js";

function report(endpoint: Record<string, unknown>): Report {
  const section = (details: unknown) => ({ score: null, summary: "", findings: [], details });
  return {
    v: 1,
    type: "openglass.checkup.report",
    reportId: "chk_test",
    checkedAt: "2026-10-05T00:00:00.000Z",
    target: { key: "k", origin: "https://agent.example", cardUrl: null, domain: "agent.example" },
    overall: null,
    sections: { card: section({}), endpoint: section(endpoint), x402: section({}), identity: section({}) },
    topFixes: [],
    openglass: { status: "not-applicable", agentId: null, domainVerified: null, profileUrl: null, claimLink: null, claimUrl: null, line: "" },
    links: { report: "https://checkup.example/r/chk_test", json: "https://checkup.example/r/chk_test.json" },
    verification: { status: "not-recorded", attestationId: null, bundleUrl: null, reason: "test", how: "" },
    note: "",
  } as unknown as Report;
}

describe("witnessLine", () => {
  it("says when OpenGlass independently witnessed the probe", () => {
    const r = report({ url: "https://agent.example/a2a", witnessed: true, witnessReason: "shadow" });
    expect(witnessLine(r)).toBe("The endpoint test message was independently witnessed by OpenGlass.");
    expect(renderText(r)).toContain("independently witnessed by OpenGlass.");
  });

  it("says plainly when it wasn't, with the reason", () => {
    const r = report({ url: "https://agent.example/a2a", witnessed: false, witnessReason: "openglass_unreachable_fallback: network error" });
    expect(witnessLine(r)).toBe("The endpoint test message was not independently witnessed by OpenGlass (openglass_unreachable_fallback: network error).");
  });

  it("says nothing when no probe ran, or for a report stored before witnessing existed", () => {
    expect(witnessLine(report({ url: null, witnessed: false, witnessReason: null }))).toBeNull();
    expect(witnessLine(report({ url: "https://agent.example/a2a" }))).toBeNull();
  });
});
