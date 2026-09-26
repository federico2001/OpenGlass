import { parse as parseYaml } from "yaml";
import { Policy as PolicySchema, type Policy } from "./types.js";

/** Parses (if given a string) and validates an openglass-policy v1 document. Throws a
 * ZodError with every structural problem (unknown fields, bad enum values, duplicate
 * rule ids) if the document doesn't conform. */
export function loadPolicy(source: string | unknown): Policy {
  const raw = typeof source === "string" ? parseYaml(source) : source;
  return PolicySchema.parse(raw);
}
