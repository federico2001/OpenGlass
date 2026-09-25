import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../app/page";
import { TwinPane } from "../components/TwinPane";

describe("GET / (home)", () => {
  const html = renderToStaticMarkup(<Home />);

  it("renders the Clear Channel headline and both audiences", () => {
    expect(html).toContain("Every agent conversation, on the record.");
    expect(html).toContain("For agents");
    expect(html).toContain("For humans");
    expect(html).toContain("Transparency isn&#x27;t a feature. It&#x27;s the whole product.");
  });

  it("only advertises API routes and surfaces that exist", () => {
    expect(html).toContain("/v1");
    expect(html).toContain("mcp.openglass.glass");
    expect(html).toContain("npm install openglass-sdk");
    expect(html).toContain("pip install openglass-sdk");
    expect(html).toContain("/skill.md");
    expect(html).not.toContain("/trace/");
  });

  it("covers the flow, what's built, under-the-hood, and straight-answers sections", () => {
    expect(html).toContain("How it works");
    expect(html).toContain("What&#x27;s built");
    expect(html).toContain("Under the hood");
    expect(html).toContain("Straight answers");
    // The FAQ should be honest about what isn't solved yet, not just sell the product.
    expect(html).toContain("not something OpenGlass solves on its own");
  });

  it("answers the concrete technical questions a reviewing agent would ask", () => {
    expect(html).toContain("Ed25519");
    expect(html).toContain("ECDSA P-256");
    expect(html).toContain("RFC 8785");
    expect(html).toContain("Object Lock");
    expect(html).toContain("/docs/SPEC.md");
    expect(html).toContain("/docs/openapi.yaml");
    expect(html).toContain("notary mode");
  });
});

describe("TwinPane", () => {
  const strokes = (size: number) => [...renderToStaticMarkup(<TwinPane size={size} />).matchAll(/stroke-width="([\d.]+)"/g)].map((m) => m[1]);

  it("uses heavier strokes as the mark shrinks (brand sheet sizes)", () => {
    expect(strokes(120)).toEqual(["2.5", "2.5"]);
    expect(strokes(56)).toEqual(["3.5", "3.5"]);
    expect(strokes(28)).toEqual(["5", "5"]);
  });

  it("is decorative unless titled", () => {
    expect(renderToStaticMarkup(<TwinPane />)).toContain('aria-hidden="true"');
    const titled = renderToStaticMarkup(<TwinPane title="OpenGlass" />);
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="OpenGlass"');
  });
});
