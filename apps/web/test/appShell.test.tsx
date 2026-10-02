import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const { activeNavHref, AppShell } = await import("../components/app/AppShell");
const { PublicOnly } = await import("../components/PublicOnly");
const { default: RootLayout } = await import("../app/layout");
const { default: GuidePage } = await import("../app/dashboard/guide/page");

afterEach(() => {
  pathname.value = "/";
});

describe("the signed-in area is separate from the public site", () => {
  it("the public header links to sign-in, not to a dashboard tab", () => {
    pathname.value = "/";
    const html = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
    expect(html).toContain('href="/login"');
    expect(html).toContain("Sign in");
    expect(html).not.toContain(">Dashboard<");
    expect(html).toContain("site-header");
  });

  it("hides the public header and footer inside /dashboard", () => {
    for (const p of ["/dashboard", "/dashboard/sessions/ses_1"]) {
      pathname.value = p;
      expect(renderToStaticMarkup(<PublicOnly>public chrome</PublicOnly>)).toBe("");
    }
    pathname.value = "/dashboardish";
    expect(renderToStaticMarkup(<PublicOnly>public chrome</PublicOnly>)).toBe("public chrome");
  });

  it("the app shell has its own navigation and holds pages until the owner loads", () => {
    pathname.value = "/dashboard/activity";
    const html = renderToStaticMarkup(<AppShell>page body</AppShell>);
    expect(html).toContain("Owner dashboard");
    for (const label of ["Overview", "Activity", "Counterparties", "How it works", "Settings"]) expect(html).toContain(`>${label}</a>`);
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("page body");
    expect(html).toContain("Loading your dashboard");
  });

  it("marks the right nav item for nested pages", () => {
    expect(activeNavHref("/dashboard")).toBe("/dashboard");
    expect(activeNavHref("/dashboard/agents/agt_1")).toBe("/dashboard");
    expect(activeNavHref("/dashboard/sessions/ses_1")).toBe("/dashboard/activity");
    expect(activeNavHref("/dashboard/attestations/att_1")).toBe("/dashboard/activity");
    expect(activeNavHref("/dashboard/counterparties/by-domain/a.example")).toBe("/dashboard/counterparties");
    expect(activeNavHref("/dashboard/settings")).toBe("/dashboard/settings");
  });
});

describe("the guide", () => {
  const html = renderToStaticMarkup(<GuidePage />);

  it("explains sessions, attestations and records, and which way messages went", () => {
    expect(html).toContain("A conversation between two agents");
    expect(html).toContain("own log");
    expect(html).toContain("The signed copy, issued at the end");
    expect(html).toContain("<strong>sent</strong>");
    expect(html).toContain("<strong>received</strong>");
    expect(html).toContain("neutral witness");
  });

  it("stays within the positioning rules", () => {
    expect(html).not.toMatch(/we verify/i);
    expect(html).toContain("Never ratings, reviews");
    expect(html).toContain("Nothing here is public");
  });
});
