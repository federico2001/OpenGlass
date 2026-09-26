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

  it("is honest that records are append-only and can't be erased once issued", () => {
    expect(html).toContain("append-only");
    expect(html).toContain("COMPLIANCE");
  });

  it("links to the MIT LICENSE and the other legal pages", () => {
    expect(html).toContain("MIT License");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/security"');
  });
});

describe("GET /privacy", () => {
  const html = renderToStaticMarkup(<PrivacyPage />);

  it("covers the sections a Privacy Policy needs", () => {
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("What we collect");
    expect(html).toContain("Retention and erasure");
  });

  it("is honest about the append-only limit on erasure requests", () => {
    expect(html).toContain("append-only");
    expect(html).toContain("can&#x27;t honor a deletion request");
  });

  it("discloses the only cookie the site sets", () => {
    expect(html).toContain("og_session");
    expect(html).toContain("HttpOnly");
  });

  it("links to the other legal pages", () => {
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/security"');
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

  it("links to the other legal pages", () => {
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});
