import { higherRisk, type Condition, type LeafCondition, type Policy, type PolicyEvent, type PolicyResult } from "./types.js";

function resolveField(field: string, event: PolicyEvent): unknown {
  if (field.startsWith("attr:")) return event.attributes?.[field.slice("attr:".length)];
  if (field.startsWith("field:")) {
    let cur: unknown = event.fields;
    for (const segment of field.slice("field:".length).split(".")) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[segment];
    }
    return cur;
  }
  // Unreachable once a Condition has passed Zod's FieldRef pattern (see types.ts).
  throw new Error(`Unrecognized field reference: ${field}`);
}

function matchLeaf(cond: LeafCondition, event: PolicyEvent): boolean {
  const actual = resolveField(cond.field, event);
  switch (cond.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "equals":
      return actual === cond.value;
    case "not_equals":
      return actual !== cond.value;
    case "in":
      return Array.isArray(cond.value) && cond.value.includes(actual);
    case "not_in":
      return Array.isArray(cond.value) && !cond.value.includes(actual);
    case "matches": {
      if (typeof actual !== "string" || typeof cond.value !== "string") return false;
      const ci = cond.value.startsWith("(?i)");
      const re = new RegExp(ci ? cond.value.slice(4) : cond.value, ci ? "i" : "");
      return re.test(actual);
    }
    case "contains":
      if (Array.isArray(actual)) return actual.includes(cond.value);
      if (typeof actual === "string" && typeof cond.value === "string") return actual.includes(cond.value);
      return false;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof cond.value !== "number") return false;
      if (cond.op === "gt") return actual > cond.value;
      if (cond.op === "gte") return actual >= cond.value;
      if (cond.op === "lt") return actual < cond.value;
      return actual <= cond.value;
    }
  }
}

function matchCondition(cond: Condition, event: PolicyEvent): boolean {
  if ("all" in cond) return cond.all.every((c) => matchCondition(c, event));
  if ("any" in cond) return cond.any.some((c) => matchCondition(c, event));
  if ("not" in cond) return !matchCondition(cond.not, event);
  return matchLeaf(cond, event);
}

/** Evaluates every rule against `event` and returns the highest risk among matches
 * (spec/openglass-policy/README.md#evaluation), or `policy.defaultRisk` (default "low")
 * if nothing matched. */
export function evaluate(policy: Policy, event: PolicyEvent): PolicyResult {
  const matches = policy.rules
    .filter((r) => matchCondition(r.when, event))
    .map((r) => ({ id: r.id, risk: r.risk, description: r.description, reasons: r.reasons ?? [] }));

  if (matches.length === 0) return { risk: policy.defaultRisk ?? "low", matches: [], defaultApplied: true };
  const risk = matches.reduce((acc, m) => higherRisk(acc, m.risk), matches[0]!.risk);
  return { risk, matches, defaultApplied: false };
}
