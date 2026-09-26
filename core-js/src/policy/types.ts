/**
 * openglass-policy v1 (spec/openglass-policy/README.md, schema.json). These Zod schemas
 * are the TS reference evaluator's own validation layer — structurally equivalent to
 * schema.json, not generated from it, so drift between the two is caught by
 * test/policy/schema.test.ts (which runs the JSON Schema itself, via ajv, over the same
 * fixtures these types are exercised against).
 */
import { z } from "zod";

export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

const KebabId = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);

/** "attr:<key>" — exact-key lookup into OTel GenAI attributes. "field:<path>" — dotted
 * path into the caller's plain event fields. See spec/openglass-policy/README.md. */
const FieldRef = z.string().regex(/^(attr|field):.+$/);

export const ConditionOp = z.enum(["equals", "not_equals", "in", "not_in", "matches", "contains", "gt", "gte", "lt", "lte", "exists", "not_exists"]);
export type ConditionOp = z.infer<typeof ConditionOp>;

export const LeafCondition = z.strictObject({
  field: FieldRef,
  op: ConditionOp,
  value: z.unknown().optional(),
});
export type LeafCondition = z.infer<typeof LeafCondition>;

export type Condition = LeafCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    LeafCondition,
    z.strictObject({ all: z.array(Condition).min(1) }),
    z.strictObject({ any: z.array(Condition).min(1) }),
    z.strictObject({ not: Condition }),
  ]),
);

export const PolicyRule = z.strictObject({
  id: KebabId,
  risk: RiskLevel,
  description: z.string().max(2000).optional(),
  when: Condition,
  reasons: z.array(z.string().max(500)).optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const Policy = z
  .strictObject({
    apiVersion: z.literal("openglass-policy/v1"),
    kind: z.literal("Policy"),
    metadata: z.strictObject({ name: KebabId, description: z.string().max(2000).optional() }),
    defaultRisk: RiskLevel.optional(),
    rules: z.array(PolicyRule),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const r of p.rules) {
      if (seen.has(r.id)) ctx.addIssue({ code: "custom", message: `duplicate rule id "${r.id}"`, path: ["rules"] });
      seen.add(r.id);
    }
  });
export type Policy = z.infer<typeof Policy>;

export interface PolicyEvent {
  /** OpenTelemetry GenAI semantic-convention span attributes, keyed by their flat
   * (dotted) name exactly as OTel emits them, e.g. "gen_ai.tool.name". */
  attributes?: Record<string, string | number | boolean | null>;
  /** Arbitrary plain fields the caller supplies alongside or instead of attributes. */
  fields?: Record<string, unknown>;
}

export interface RuleMatch {
  id: string;
  risk: RiskLevel;
  description?: string;
  reasons: string[];
}

export interface PolicyResult {
  /** The highest risk among every matched rule, or the policy's defaultRisk if none matched. */
  risk: RiskLevel;
  /** Every rule that matched, in policy order — not just the highest-risk one. */
  matches: RuleMatch[];
  defaultApplied: boolean;
}
