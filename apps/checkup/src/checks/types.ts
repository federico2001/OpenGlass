import type { NetPolicy } from "../net.js";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  severity: Severity;
  /** One imperative sentence: what to change. */
  fix: string;
}

export interface Section<D> {
  /** 0–100, or null when the section doesn't apply or couldn't be tested. */
  score: number | null;
  summary: string;
  findings: Finding[];
  details: D;
}

export interface CheckDeps {
  net: NetPolicy;
  /** A2A Registry base URL, e.g. https://a2aregistry.org. */
  registryUrl: string;
}

export const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Target-controlled text going into our own plain-language output: printable characters
 * only, bounded, never interpreted. */
export function quoteData(value: unknown, max = 80): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
