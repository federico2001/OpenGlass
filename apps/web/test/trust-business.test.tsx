import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BusinessPage from "../app/business/page";
import DocsPage from "../app/docs/page";
import StatusPage from "../app/status/page";
import TrustPage from "../app/trust/page";
import sitemap from "../app/sitemap";

describe("GET /trust", () => {
  const html = renderToStaticMarkup(<TrustPage />);

  it("covers what you can check, who can see a record, retention and controls", () => {
    for (const h of ["What OpenGlass is", "What you can check yourself", "Who can see a record", "Retention and deletion", "Controls you have"]) {
      expect(html).toContain(h);
    }
    expect(html).toContain("/.well-known/openglass-keys.json");
    expect(html).toContain("countersigned by OpenGlass when it arrives");
  });

  it("states plainly what doesn't exist yet and claims no certification", () => {
    expect(html).toContain("No external timestamp anchor.");
    expect(html).toContain("No SOC\u00a02 report");
    expect(html).toContain("No uptime SLA.");
    expect(html).toContain("No SSO or organization accounts.");
    expect(html).not.toMatch(/SOC 2 (compliant|certified)/i);
    expect(html).not.toContain("[FOUNDER");
  });

  it("never says a record is public", () => {
    expect(html).toContain("Never public.");
    expect(html).not.toMatch(/records? (is|are) public/i);
  });
});

describe("GET /business", () => {
  const html = renderToStaticMarkup(<BusinessPage />);

  it("leads with the shared proof and the neutral witness", () => {
    expect(html).toContain("you both need the same proof");
    expect(html).toContain("OpenGlass is a neutral witness.");
    expect(html).toContain("The problem (illustrative)");
  });

  it("makes no claim it can't back and links the Trust page", () => {
    expect(html).toContain("Not quietly.");
    expect(html).toContain('href="/trust"');
    expect(html).not.toContain("[FOUNDER");
    expect(html).not.toMatch(/customers?|case stud/i);
  });
});

describe("GET /docs and /status", () => {
  it("indexes every public reference", () => {
    const html = renderToStaticMarkup(<DocsPage />);
    for (const href of ["/skill.md", "/docs/SPEC.md", "/docs/openapi.yaml", "/docs/POLICY.md", "/llms-full.txt", "/.well-known/openglass-keys.json", "/status"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("renders the status checks before the first poll returns", () => {
    const html = renderToStaticMarkup(<StatusPage />);
    expect(html).toContain("Checking");
    for (const name of ["API", "Database", "Evidence storage", "Platform keys"]) expect(html).toContain(name);
    expect(html).toContain("Records already issued stay verifiable");
  });

  it("all four pages are in the sitemap", () => {
    const urls = sitemap().map((e) => e.url);
    for (const path of ["/trust", "/business", "/docs", "/status"]) expect(urls).toContain(`https://localhost${path}`);
  });
});
