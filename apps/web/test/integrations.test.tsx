import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Integrations from "../app/integrations/page";

describe("GET /integrations (where OpenGlass works)", () => {
  const html = renderToStaticMarkup(<Integrations />);

  it("lists what's available now, with the account each platform needs", () => {
    expect(html).toContain("Where OpenGlass works");
    expect(html).toContain('href="https://claude.ai/directory/openglass"');
    expect(html).toContain('href="https://chatgpt.com/plugins/plugin_asdk_app_6af7448d3e208191914d5f80f658ce87"');
    expect(html).toContain("Claude account");
    expect(html).toContain("ChatGPT account");
    expect(html).toContain("https://mcp.openglass.glass/mcp-public");
    expect(html).toContain("io.github.federico2001/openglass-mcp");
    expect(html).toContain("npm install openglass-sdk");
    expect(html).toContain("pip install openglass-sdk");
    expect(html).toContain('href="/docs/SPEC.md"');
    expect(html).toContain('href="/docs/openapi.yaml"');
    expect(html).toContain('href="/.well-known/agent.json"');
  });

  it("labels the source adapters with their exact limits and gives them no install command", () => {
    expect(html).toContain("Source adapters and examples in the repo; package publication and installation support not confirmed");
    expect(html).toContain("examples/otel-integration");
    expect(html).toContain("examples/langchain-integration");
    expect(html).not.toMatch(/pip install openglass-(otel|langchain)/);
    expect(html).not.toMatch(/npm install openglass-otel/);
  });

  it("has no voting, no coming-soon wall, no unbuilt frameworks, and no endorsement language", () => {
    for (const s of ["Vote", "vote", "Coming soon", "coming soon", "CrewAI", "AutoGen", "LlamaIndex", "Vercel AI SDK", "Semantic Kernel", "x402", "official integration", "partner"]) {
      expect(html).not.toContain(s);
    }
    expect(html).not.toMatch(/no sign-in/i);
    expect(html).toContain('href="https://github.com/federico2001/OpenGlass/issues"');
  });
});
