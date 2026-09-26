import type { AgentDoc } from "@openglass/db";

/**
 * Owner-set spend limits on an agent's own x402 premium purchases (Prompt 6 follow-up).
 * Fixed USD prices (in cents) per premium route — kept here as plain integers rather than
 * derived from server.ts's x402 `RoutesConfig`, whose `price` values are strings ("$1.00")
 * meant for the facilitator, not arithmetic. Keep both in sync by hand if a price changes.
 */
export const VERIFIED_BADGE_PRICE_CENTS = 100;
export const EXTEND_RETENTION_PRICE_CENTS = 50;
export const PDF_PRICE_CENTS = 25;

/** The price of the premium route a request targets, or `null` if it isn't one. Path
 * matching only — the caller still goes through real routing/auth afterward. */
export function premiumRoutePriceCents(method: string, rawUrl: string): number | null {
  const path = rawUrl.split("?")[0] ?? "";
  if (method === "POST" && path === "/v1/premium/agents/me/verified-badge") return VERIFIED_BADGE_PRICE_CENTS;
  if (method === "POST" && /^\/v1\/premium\/records\/[^/]+\/extend-retention$/.test(path)) return EXTEND_RETENTION_PRICE_CENTS;
  if (method === "GET" && /^\/v1\/premium\/records\/[^/]+\/pdf$/.test(path)) return PDF_PRICE_CENTS;
  return null;
}

/** Whether spending `priceCents` more would put this agent over its owner-set limit.
 * `spendLimitUsdCents` absent/null means unlimited. */
export function wouldExceedSpendLimit(agent: Pick<AgentDoc, "spendLimitUsdCents" | "totalSpendUsdCents">, priceCents: number): boolean {
  const limit = agent.spendLimitUsdCents ?? null;
  if (limit === null) return false;
  return (agent.totalSpendUsdCents ?? 0) + priceCents > limit;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
