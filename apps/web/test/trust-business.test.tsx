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

describe("/trust, deletion", () => {
  it("offers deleting an agent without history and claims no automatic cleanup", () => {
    const html = renderToStaticMarkup(<TrustPage />);
    expect(html).toContain("Delete an agent that has no sessions or attestations");
    expect(html).not.toContain("deleted automatically after 30 days");
  });
});

describe("second review round", () => {
  it("/trust treats the human owner as a feature, not a gap", () => {
    const html = renderToStaticMarkup(<TrustPage />);
    expect(html).not.toContain("A human in the loop.");
    expect(html.indexOf("Every agent has a human owner")).toBeLessThan(html.indexOf('id="check"'));
  });

  it("/business links /trust and /status as proof points near the top", () => {
    const html = renderToStaticMarkup(<BusinessPage />);
    const proof = html.indexOf("Check before you trust us");
    expect(proof).toBeGreaterThan(0);
    expect(proof).toBeLessThan(html.indexOf("The problem (illustrative)"));
    expect(html.slice(proof, proof + 400)).toContain('href="/status"');
  });

  it("/trust names the region and the incident notice", () => {
    const html = renderToStaticMarkup(<TrustPage />);
    expect(html).toContain("AWS us-east-1");
    expect(html).toContain("within 72 hours of confirming it");
  });

  it("/business says pilots are free", () => {
    expect(renderToStaticMarkup(<BusinessPage />)).toContain("Pilot terms for teams: pilots are free.");
  });
});

describe("Oct 20 website and docs brief", () => {
  const business = renderToStaticMarkup(<BusinessPage />);
  const LIMIT =
    "An attestation proves this record existed at that time and has not changed since. It does not prove the other side said or did anything. When both sides need to stand behind the evidence, run a session.";
  const squash = (html: string) => html.replace(/\s+/g, " ").replace(/&#x27;|&apos;/g, "'");

  it("/business answers whether the other company needs OpenGlass, verbatim", () => {
    expect(squash(business)).toContain(
      "Not always. To keep your own signed record of any interaction, no: your agent attests what it sent and received, and OpenGlass countersigns it. For a record both companies sign and hold, yes: the other company joins once through your invite link, with no prior setup between your companies. Every session after that just runs.",
    );
  });

  it("states the attestation limit wherever attestations are described", () => {
    for (const html of [business, renderToStaticMarkup(<TrustPage />)]) expect(squash(html)).toContain(LIMIT);
  });

  it("marks witnessed fetch as planned, in the table and its own section", () => {
    const html = squash(business);
    expect(html).toContain("Witnessed fetch <span");
    expect(html.match(/>Planned</g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("A witnessed fetch record is one-sided evidence.");
    expect(html).toContain("What if the other company will not join at all? (planned)");
  });

  it("never overclaims", () => {
    for (const html of [business, renderToStaticMarkup(<TrustPage />)]) {
      expect(html).not.toMatch(/court-proof|legally binding|admissible|signs on both sides/i);
      expect(html).not.toContain("FOUNDER TO FILL");
    }
  });
});
