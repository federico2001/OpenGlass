import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "../app/page";
import { PROMPT_SHOWN, SETUP_PROMPT } from "../components/SetupPrompt";
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

  it("shows the witness diagram under the headline, then a copyable setup prompt", () => {
    const title = html.indexOf("Every agent conversation, on the record.");
    const diagram = html.indexOf("<figure");
    const prompt = html.indexOf("Add a witness to your agent (5 minutes)");
    expect(title).toBeLessThan(diagram);
    expect(diagram).toBeLessThan(prompt);
    // A small cue under the diagram points down to the prompt, which starts below the first screen.
    const cue = html.indexOf('href="#setup"');
    expect(diagram).toBeLessThan(cue);
    expect(cue).toBeLessThan(prompt);
    expect(html).toContain('id="setup"');
    expect(html).toContain("Prompt for your Claude Code, Codex or preferred AI (It&#x27;ll know what to do)");
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
  it("is a short ask that points the coding agent at the setup guide", () => {
    expect(SETUP_PROMPT).toBe(
      "Add OpenGlass to my agent as a neutral witness, so its interactions with other agents and APIs end up on a " +
        "signed, hash-chained record that nobody can quietly change. Setup guide: https://openglass.glass/skill.md" +
        "\n\nAsk me anything you need.",
    );
    expect(SETUP_PROMPT).not.toMatch(/always call OpenGlass/i);
  });

  it("shows the prompt without the link; only the copied text carries it", () => {
    expect(PROMPT_SHOWN).toBe(SETUP_PROMPT.replace(" Setup guide: https://openglass.glass/skill.md", ""));
    const home = renderToStaticMarkup(<Home />);
    expect(home).toContain("Ask me anything you need.");
    expect(home).not.toContain("Setup guide:");
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
