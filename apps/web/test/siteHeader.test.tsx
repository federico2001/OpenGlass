import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
const { SiteHeader, SITE_NAV_LINKS } = await import("../components/SiteHeader");

describe("public site header", () => {
  const html = renderToStaticMarkup(<SiteHeader />);

  it("keeps the logo as its own link, outside the navigation", () => {
    const brand = html.indexOf('class="brand"');
    const nav = html.indexOf("<nav");
    expect(brand).toBeGreaterThan(-1);
    expect(brand).toBeLessThan(nav);
    expect(html.slice(nav)).not.toContain('class="brand"');
  });

  it("has a menu toggle that names its state and controls the nav", () => {
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="site-nav"');
    expect(html).toContain('aria-label="Open menu"');
    expect(html).toContain('<nav id="site-nav" class="site-nav" aria-label="Main"');
  });

  it("lists every public link", () => {
    for (const l of SITE_NAV_LINKS) expect(html).toContain(`href="${l.href}"`);
    expect(SITE_NAV_LINKS.map((l) => l.label)).toEqual(["For agents", "Pricing", "Directory", "Live", "Integrations", "Sign in"]);
  });
});
