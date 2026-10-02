import { claimsX402 } from "../a2a.js";
import type { EndpointResult } from "./endpoint.js";
import { kindOf, paymentRequiredIn } from "./endpoint.js";
import type { Finding, Section } from "./types.js";

export interface X402Details {
  claimed: boolean;
  /** The unpaid request is the endpoint check's own test message (one request, not two). */
  unpaidRequest: "endpoint-probe" | null;
  signal: "http-402" | "a2a-extension" | null;
  x402Version: number | null;
  problems: string[];
}

/**
 * x402: when the card claims it takes x402 payments, the endpoint check's unpaid message
 * should come back asking for payment — either an HTTP 402 carrying payment requirements
 * (x402 v2 in the `PAYMENT-REQUIRED` header, v1 in the JSON body), or an A2A task in the
 * x402 extension's `payment-required` state.
 */
export function checkX402(card: Record<string, unknown> | null, endpoint: EndpointResult): Section<X402Details> {
  const claimed = !!card && claimsX402(card);
  const details: X402Details = { claimed, unpaidRequest: null, signal: null, x402Version: null, problems: [] };
  if (!claimed) return { score: null, summary: "Not applicable: the card doesn't claim x402.", findings: [], details };

  const response = endpoint.response;
  if (!response) return { score: null, summary: "Not tested: the endpoint didn't answer.", findings: [], details };
  details.unpaidRequest = "endpoint-probe";

  let requirements: unknown = null;
  if (response.status === 402) {
    details.signal = "http-402";
    const header = response.headers.get("payment-required");
    if (header) {
      try {
        requirements = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        details.problems.push("the PAYMENT-REQUIRED header isn't base64-encoded JSON");
      }
    } else {
      requirements = endpoint.json;
      if (!requirements) details.problems.push("the 402 has neither a PAYMENT-REQUIRED header nor a JSON body");
    }
  } else {
    const result = (endpoint.json as { result?: unknown } | null)?.result ?? endpoint.json;
    if (kindOf(result) === "payment-required") {
      details.signal = "a2a-extension";
      const r = result as Record<string, unknown>;
      requirements = paymentRequiredIn((r.kind === "task" ? r : r.task) as Record<string, unknown>);
    }
  }

  if (!details.signal) {
    return {
      score: 40,
      summary: "The card claims x402, but the unpaid test message was answered without asking for payment.",
      findings: [{ severity: "medium", fix: "Answer unpaid requests to paid skills with HTTP 402 and payment requirements, or stop claiming x402 on the card." }],
      details,
    };
  }

  if (requirements) details.problems.push(...validateRequirements(requirements, details));
  const findings: Finding[] = [];
  if (details.problems.length > 0) {
    findings.push({ severity: "high", fix: `Fix the payment requirements: ${details.problems[0]}.` });
  }
  const score = details.problems.length === 0 ? 100 : Math.max(20, 70 - 15 * details.problems.length);
  const how = details.signal === "http-402" ? "HTTP 402" : "an A2A x402 payment-required task";
  return {
    score,
    summary: details.problems.length === 0 ? `Unpaid request got a well-formed ${how}.` : `Unpaid request got ${how}, but it isn't well-formed (${details.problems.length} problem${details.problems.length === 1 ? "" : "s"}).`,
    findings,
    details,
  };
}

function validateRequirements(value: unknown, details: X402Details): string[] {
  const problems: string[] = [];
  if (!value || typeof value !== "object") return ["the payment requirements aren't a JSON object"];
  const req = value as { x402Version?: unknown; accepts?: unknown };
  if (typeof req.x402Version !== "number") problems.push("x402Version is missing");
  else details.x402Version = req.x402Version;
  if (!Array.isArray(req.accepts) || req.accepts.length === 0) {
    problems.push("accepts is missing or empty");
    return problems;
  }
  req.accepts.slice(0, 10).forEach((option, i) => {
    const o = (option ?? {}) as Record<string, unknown>;
    for (const field of ["scheme", "network", "payTo", "asset"]) {
      if (typeof o[field] !== "string" || !o[field]) problems.push(`accepts[${i}].${field} is missing`);
    }
    if (o.amount === undefined && o.maxAmountRequired === undefined) problems.push(`accepts[${i}] has no amount`);
  });
  return problems;
}
