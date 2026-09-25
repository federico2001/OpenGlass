import { describe, expect, it } from "vitest";
import {
  EXTEND_RETENTION_PRICE_CENTS,
  PDF_PRICE_CENTS,
  VERIFIED_BADGE_PRICE_CENTS,
  formatUsd,
  premiumRoutePriceCents,
  wouldExceedSpendLimit,
} from "../../src/domain/spendLimits.js";

describe("premiumRoutePriceCents", () => {
  it("prices each premium route, ignoring any query string", () => {
    expect(premiumRoutePriceCents("POST", "/v1/premium/agents/me/verified-badge")).toBe(VERIFIED_BADGE_PRICE_CENTS);
    expect(premiumRoutePriceCents("POST", "/v1/premium/records/rec_123/extend-retention")).toBe(EXTEND_RETENTION_PRICE_CENTS);
    expect(premiumRoutePriceCents("GET", "/v1/premium/records/rec_123/pdf?download=1")).toBe(PDF_PRICE_CENTS);
  });

  it("doesn't price a non-premium route or the wrong HTTP method", () => {
    expect(premiumRoutePriceCents("GET", "/v1/premium/agents/me/verified-badge")).toBeNull(); // it's a POST route
    expect(premiumRoutePriceCents("GET", "/v1/premium/records/rec_123/retention")).toBeNull(); // free status route
    expect(premiumRoutePriceCents("GET", "/v1/sessions")).toBeNull();
  });
});

describe("wouldExceedSpendLimit", () => {
  it("never exceeds an unset (unlimited) limit", () => {
    expect(wouldExceedSpendLimit({ spendLimitUsdCents: null, totalSpendUsdCents: 100_000 }, 100)).toBe(false);
    expect(wouldExceedSpendLimit({}, 100)).toBe(false);
  });

  it("compares the next purchase against what's already been spent", () => {
    expect(wouldExceedSpendLimit({ spendLimitUsdCents: 100, totalSpendUsdCents: 0 }, 100)).toBe(false); // exactly at the limit is fine
    expect(wouldExceedSpendLimit({ spendLimitUsdCents: 100, totalSpendUsdCents: 1 }, 100)).toBe(true);
    expect(wouldExceedSpendLimit({ spendLimitUsdCents: 0, totalSpendUsdCents: 0 }, 1)).toBe(true); // a zero limit blocks any purchase
  });
});

describe("formatUsd", () => {
  it("formats cents as a dollar string", () => {
    expect(formatUsd(100)).toBe("$1.00");
    expect(formatUsd(50)).toBe("$0.50");
    expect(formatUsd(0)).toBe("$0.00");
  });
});
