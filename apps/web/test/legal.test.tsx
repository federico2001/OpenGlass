import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TermsPage from "../app/terms/page";
import PrivacyPage from "../app/privacy/page";
import SecurityPage from "../app/security/page";

describe("GET /terms", () => {
  const html = renderToStaticMarkup(<TermsPage />);

  it("covers the sections a Terms of Service needs", () => {
    expect(html).toContain("Terms of Service");
    expect(html).toContain("Acceptable use");
    expect(html).toContain("Limitation of liability");
  });

  it("is honest that sealed/shared records are append-only and permanent, but private ones are erasable (realignment R8)", () => {
    expect(html).toContain("append-only");
    expect(html).toContain("COMPLIANCE");
    expect(html).toContain("erasure is real");
    expect(html).toContain("Notary mode");
  });

  it("distinguishes visibility (who can see it) from mode (what we can even store)", () => {
    expect(html).toContain("visibility");
    expect(html).toContain("Relay mode");
  });

  it("links to the MIT LICENSE and the other legal pages", () => {
    expect(html).toContain("MIT License");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/security"');
  });

  it("carries a changelog and an updated date", () => {
    expect(html).toContain("September 30, 2026");
    expect(html).toContain("September 28, 2026");
    expect(html).toContain("Changelog");
  });
});

describe("GET /privacy", () => {
  const html = renderToStaticMarkup(<PrivacyPage />);

  it("covers the sections a Privacy Policy needs", () => {
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("What we collect");
    expect(html).toContain("Retention and erasure");
  });

  it("is honest that sealed/shared retention is absolute but private retention is real and owner-chosen (realignment R8)", () => {
    expect(html).toContain("can&#x27;t honor a deletion request");
    expect(html).toContain("ninety days by default");
    expect(html).toContain("we delete the encryption key");
  });

  it("says plainly who besides the owner can see a session or attestation's content", () => {
    expect(html).toContain("Who can see a session or attestation&#x27;s content");
    expect(html).toContain("Sessions default to shared");
    expect(html).toContain("No visibility makes a record public");
    expect(html).toContain("sealed");
    expect(html).toContain("shared");
    expect(html).toContain("read");
    expect(html).toContain("export");
  });

  it("explains that a dispute is a flag on any record, and only opens a legacy sealed one", () => {
    expect(html).toContain("Disputes");
    expect(html).toContain("/dispute");
    expect(html).toContain("A dispute is a flag");
    expect(html).not.toContain("Sealed</strong> (the session default)");
  });

  it("discloses the only cookie the site sets", () => {
    expect(html).toContain("og_session");
    expect(html).toContain("HttpOnly");
  });

  it("links to the other legal pages", () => {
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/security"');
  });

  it("documents how lookup/profile data is computed and how owners correct it (realignment R2/R3/R8)", () => {
    expect(html).toContain("How lookup data works, and how to correct it");
    expect(html).toContain("GET /v1/lookup");
    expect(html).toContain("domain-verified counterparties");
  });

  it("carries a changelog and an updated date", () => {
    expect(html).toContain("September 30, 2026");
    expect(html).toContain("September 28, 2026");
    expect(html).toContain("Changelog");
  });
});

describe("GET /security", () => {
  const html = renderToStaticMarkup(<SecurityPage />);

  it("describes the real cryptographic design, not generic security copy", () => {
    expect(html).toContain("Ed25519");
    expect(html).toContain("ECDSA P-256");
    expect(html).toContain("RFC");
    expect(html).toContain("/docs/SPEC.md");
  });

  it("gives a way to report a vulnerability", () => {
    expect(html).toContain("security@openglass.glass");
    expect(html).toContain("safe harbor");
  });

  it("documents domain verification, previously referenced elsewhere but undocumented here (realignment R8)", () => {
    expect(html).toContain("Domain verification");
    expect(html).toContain("DNS TXT");
    expect(html).toContain("well-known");
    expect(html).toContain("SSRF");
  });

  it("describes private-record envelope encryption and qualifies the Object Lock claim", () => {
    expect(html).toContain("AES-256");
    expect(html).toContain("deletable by design");
  });

  it("links to the other legal pages", () => {
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });

  it("carries a changelog and an updated date", () => {
    expect(html).toContain("September 30, 2026");
    expect(html).toContain("September 28, 2026");
    expect(html).toContain("Changelog");
  });
});
