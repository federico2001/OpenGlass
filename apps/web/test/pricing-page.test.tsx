import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PricingPage from "../app/pricing/page";

/**
 * Realignment R5's draft copy for this page described "Free / Owner / Business" as paid
 * subscription tiers — but the product has no billing/plan-gating system at all outside
 * the real per-use x402 add-ons (verified badge, extended retention, PDF export). Rather
 * than publish fabricated subscription pricing, this page states plainly that the core
 * protocol (including everything the draft called "Owner" and "Business") is free, and
 * only the genuine x402 add-ons cost anything. These tests guard that honesty choice.
 */
describe("GET /pricing (realignment R5)", () => {
  const html = renderToStaticMarkup(<PricingPage />);

  it("doesn't invent a subscription plan that doesn't exist", () => {
    expect(html).not.toContain("/month");
    expect(html).not.toContain("/mo<");
    expect(html).not.toContain("Owner plan");
    expect(html).not.toContain("Business plan");
    expect(html).toContain("No account tiers");
  });

  it("states the real, currently-free feature set", () => {
    expect(html).toContain("GET /v1/lookup");
    expect(html).toContain("Owner dashboard");
    expect(html).toContain("Witnessed two-party sessions (shared or private)");
  });

  it("prices the real x402 add-ons correctly", () => {
    expect(html).toContain("$1.00");
    expect(html).toContain("$0.50");
    expect(html).toContain("$0.25");
    expect(html).toContain("x402");
    expect(html).toContain("USDC");
  });
});
