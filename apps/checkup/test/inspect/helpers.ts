import { inspectContent, type ContentReport } from "../../src/inspect/content.js";
import type { RuleFindings } from "../../src/inspect/common.js";

export const html = (s: string, perRuleCap?: number): ContentReport => inspectContent({ kind: "html", bytes: Buffer.from(s, "utf8"), perRuleCap });
export const text = (s: string): ContentReport => inspectContent({ kind: "text", bytes: Buffer.from(s, "utf8") });
export const rule = (r: { findings: RuleFindings[] }, id: string): RuleFindings | undefined => r.findings.find((f) => f.rule === id);
export const rules = (r: { findings: RuleFindings[] }): string[] => r.findings.map((f) => f.rule).sort();

/** Words the reports must never use as a verdict. The MCP config's standing note is the one
 * mandated exception ("Cannot tell whether a server is malicious; ... not a safety guarantee"). */
export const VERDICT_WORDS = /\b(?:safe|unsafe|malicious|trustworthy|clean|dangerous|suspicious)\b/i;
