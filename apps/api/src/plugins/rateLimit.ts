import { rateLimitsRepository } from "@openglass/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { sendError } from "../errors.js";

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/** SPEC §10 defaults. Env-var overrides (`RATE_LIMIT_<RULE>`) are not implemented yet —
 * these are the documented defaults, which the spec treats as the baseline behavior. */
export const RATE_LIMIT_RULES = {
  auth_email_per_email: { limit: 5, windowMs: 3_600_000 },
  auth_email_per_ip: { limit: 30, windowMs: 3_600_000 },
  agent_register: { limit: 10, windowMs: 3_600_000 },
  claim_preview: { limit: 30, windowMs: 3_600_000 },
  claim_accept: { limit: 10, windowMs: 3_600_000 },
  session_create: { limit: 60, windowMs: 3_600_000 },
  invite_respond: { limit: 60, windowMs: 3_600_000 },
  message_send_per_agent: { limit: 120, windowMs: 60_000 },
  message_send_per_session: { limit: 60, windowMs: 60_000 },
  session_close: { limit: 60, windowMs: 3_600_000 },
  read: { limit: 600, windowMs: 60_000 },
  verify: { limit: 30, windowMs: 60_000 },
  unauthenticated_default: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitRuleName = keyof typeof RATE_LIMIT_RULES;

/** Fixed-window rate limiting (SPEC §10 / D11) backed by the `rate_limits` collection.
 * Always sets the `RateLimit-*` response headers; sends `429 rate_limited` with
 * `Retry-After` once the window's count exceeds the rule's limit. */
export function rateLimit(db: Db, rule: RateLimitRuleName, keyFn: (req: FastifyRequest) => string) {
  const repo = rateLimitsRepository(db);
  const { limit, windowMs } = RATE_LIMIT_RULES[rule];

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { count, resetAt } = await repo.increment(rule, keyFn(req), windowMs, new Date());
    const retryAfterSec = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    reply.header("RateLimit-Limit", String(limit));
    reply.header("RateLimit-Remaining", String(Math.max(0, limit - count)));
    reply.header("RateLimit-Reset", String(Math.ceil(resetAt.getTime() / 1000)));
    if (count > limit) {
      reply.header("Retry-After", String(retryAfterSec));
      sendError(reply, 429, "rate_limited", "Rate limit exceeded", { rule, retryAfterSec });
    }
  };
}
