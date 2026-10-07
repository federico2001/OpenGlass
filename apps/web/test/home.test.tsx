import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../app/page";
import { SETUP_PROMPT } from "../components/SetupPrompt";
import { TwinPane } from "../components/TwinPane";

describe("GET / (home)", () => {
  const html = renderToStaticMarkup(<Home />);

  it("leads with the neutral witness and links to both onward audiences", () => {
    expect(html).toContain("The neutral witness for agent-to-agent interactions");
    expect(html).toContain("Every agent conversation, on the record.");
    expect(html).toContain("favors neither");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/agents"');
  });

  it("puts a copyable setup prompt for Claude Code or Codex right under the headline", () => {
    const title = html.indexOf("Every agent conversation, on the record.");
    const prompt = html.indexOf("Add a witness to your agent");
    const diagram = html.indexOf("favors neither");
    expect(title).toBeLessThan(prompt);
    expect(prompt).toBeLessThan(diagram);
    expect(html).toContain("Claude Code or Codex");
    expect(html).toContain("Copy prompt");
  });

  it("explains the witness with a diagram, not a paragraph", () => {
    expect(html).toContain("<figure");
    expect(html).toContain("Agent A");
    expect(html).toContain("Agent B");
    expect(html).toContain("signs every message");
    expect(html).toContain("engagement");
    expect(html).toContain("agreement");
    expect(html).not.toContain("counter<");
    expect(html).toContain("nobody can change it, OpenGlass included");
    // The long scenario paragraph lives on /agents now.
    expect(html).not.toContain("Two AI agents negotiate a deal");
  });

  it("shows the repo is open source near the top", () => {
    expect(html).toContain("Open source (MIT) on GitHub");
    expect(html.indexOf("Open source (MIT)")).toBeLessThan(html.indexOf("One record, both sides"));
  });

  it("covers the witness pillars in order, with the shared record first", () => {
    const order = [
      "One record, both sides",
      "A witness, not a party",
      "Check it yourself",
      "Your agent&#x27;s own actions, on the record",
      "Stay in control",
      "Your records, your rules",
    ];
    const positions = order.map((h) => html.indexOf(`<h2>${h}</h2>`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Realignment R4 item 3 (instruction tracing) was deliberately deferred — the homepage
    // must not claim a capability that doesn't exist yet.
    expect(html).not.toContain("instruction tracing");
    expect(html).not.toContain("trace an action");
  });

  it("doesn't sell identity or lookup: that's what agent registries do, and it dilutes the witness", () => {
    expect(html).not.toContain("Know who your agent is talking to");
    expect(html).not.toContain("Who&#x27;s on the other side");
    expect(html).not.toContain("/v1/lookup");
    expect(html).not.toContain("domain verification");
    expect(html).not.toContain("impersonate");
  });

  it("covers under-the-hood and straight-answers sections", () => {
    expect(html).toContain("Under the hood");
    expect(html).toContain("Straight answers");
  });

  it("answers the witness questions in the FAQ", () => {
    expect(html).toContain("Can this be used against me?");
    expect(html).toContain("Who can see my agent&#x27;s conversations?");
    expect(html).toContain("How long is data kept?");
    expect(html).toContain("Can OpenGlass alter a past record?");
    expect(html).toContain("What happens if OpenGlass goes down?");
  });

  it("keeps the witness framing without court/legal-team language", () => {
    expect(html).toContain("A witness, not a party");
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

describe("setup prompt", () => {
  it("adds openglass-sdk in shadow mode, so the agent's own calls stay the real ones", () => {
    expect(SETUP_PROMPT).toContain("openglass-sdk");
    expect(SETUP_PROMPT).toContain("attestedFetch");
    expect(SETUP_PROMPT).toContain('mode: "shadow"');
    expect(SETUP_PROMPT).toContain("result.direct");
  });

  it("doesn't fetch side-effecting calls twice and never lets OpenGlass break the agent", () => {
    expect(SETUP_PROMPT).toContain("don't fetch twice");
    expect(SETUP_PROMPT).toContain("sendAttestationEvent");
    expect(SETUP_PROMPT).toContain("never break the agent");
  });

  it("keeps the private key out of git and doesn't tell the agent to wrap every call", () => {
    expect(SETUP_PROMPT).toContain("never in git");
    expect(SETUP_PROMPT).toContain("leave the rest alone");
    expect(SETUP_PROMPT).not.toMatch(/always call OpenGlass/i);
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
