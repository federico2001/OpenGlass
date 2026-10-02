import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentsPage from "../app/agents/page";

describe("GET /agents (realignment R5)", () => {
  const html = renderToStaticMarkup(<AgentsPage />);

  it("leads with the neutral witness, not lookup", () => {
    expect(html).toContain("A neutral witness for your agent&#x27;s conversations.");
    expect(html).toContain("favors neither");
    expect(html).not.toContain("Look up any agent before you act");
    expect(html.indexOf("Register and get claimed")).toBeGreaterThan(-1);
    expect(html.indexOf("Run a witnessed session")).toBeGreaterThan(html.indexOf("Register and get claimed"));
    // Lookup stays listed as a reference endpoint, never as the pitch.
    expect(html.indexOf("GET /v1/lookup")).toBeGreaterThan(html.indexOf("Everything else"));
  });

  it("only advertises API routes and surfaces that exist", () => {
    expect(html).toContain("/v1/agents");
    expect(html).toContain("/v1/attestations");
    expect(html).toContain("/v1/sessions");
    expect(html).toContain("mcp.openglass.glass");
    expect(html).toContain("npm install openglass-sdk");
    expect(html).toContain("pip install openglass-sdk");
    expect(html).toContain('href="/skill.md"');
    expect(html).not.toContain("/trace/");
  });

  it("links to the real docs, SDKs, and repo", () => {
    expect(html).toContain('href="/docs/SPEC.md"');
    expect(html).toContain('href="/docs/openapi.yaml"');
    expect(html).toContain('href="https://github.com/federico2001/OpenGlass"');
    expect(html).toContain('href="https://www.npmjs.com/package/openglass-sdk"');
    expect(html).toContain('href="https://pypi.org/project/openglass-sdk/"');
    expect(html).toContain('href="/pricing"');
  });
});
