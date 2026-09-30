import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../app/page";
import { TwinPane } from "../components/TwinPane";

describe("GET / (home)", () => {
  const html = renderToStaticMarkup(<Home />);

  it("leads with the neutral witness, plus lookup, and links to both onward audiences", () => {
    expect(html).toContain("The neutral witness for agent-to-agent interactions");
    expect(html).toContain("Know who your agent is talking to, and keep a record both sides trust.");
    expect(html).toContain("favors neither");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/agents"');
  });

  it("covers all five pillars, with the shared record second", () => {
    const order = ["Who&#x27;s on the other side", "One record, both sides", "What your agent did", "Stay in control", "Your records, your rules"];
    const positions = order.map((h) => html.indexOf(`<h2>${h}</h2>`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Realignment R4 item 3 (instruction tracing) was deliberately deferred — the homepage
    // must not claim a capability that doesn't exist yet.
    expect(html).not.toContain("instruction tracing");
    expect(html).not.toContain("trace an action");
  });

  it("covers what's built, under-the-hood, and straight-answers sections", () => {
    expect(html).toContain("Under the hood");
    expect(html).toContain("Straight answers");
    // Realignment R2: the impersonation FAQ answer should point at domain verification —
    // the real (opt-in) mitigation — not claim the problem is unsolved.
    expect(html).toContain("domain verification");
    expect(html).toContain("operated by");
  });

  it("carries the new R5 FAQ, not the old one", () => {
    expect(html).toContain("Can this be used against me?");
    expect(html).toContain("Who can see my agent&#x27;s conversations?");
    expect(html).toContain("How long is data kept?");
    expect(html).toContain("Can someone impersonate my brand?");
  });

  it("keeps the witness framing without court/legal-team language", () => {
    expect(html).toContain("the witness in the middle");
    expect(html).not.toContain("never looks away");
    expect(html).not.toContain("court");
    expect(html).not.toContain("legal team");
  });

  it("says both owners see a session record from the start, with no unseal ceremony", () => {
    expect(html).toContain("both owners get the same record, in full, from the start");
    expect(html).not.toMatch(/unseal/i);
    expect(html).not.toMatch(/\bsealed\b/i);
    expect(html).not.toContain("force-opens");
  });

  it("answers the concrete technical questions a reviewing agent would ask", () => {
    expect(html).toContain("Ed25519");
    expect(html).toContain("ECDSA P-256");
    expect(html).toContain("RFC 8785");
    expect(html).toContain("Object Lock");
    expect(html).toContain("/docs/SPEC.md");
    expect(html).toContain("/docs/openapi.yaml");
    expect(html).toContain("Notary mode");
    expect(html).not.toContain("/trace/");
  });

  it("links out to the real GitHub repo, npm, and PyPI packages", () => {
    expect(html).toContain('href="https://github.com/federico2001/OpenGlass"');
    expect(html).toContain('href="https://www.npmjs.com/package/openglass-sdk"');
    expect(html).toContain('href="https://pypi.org/project/openglass-sdk/"');
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
