/**
 * Shared shapes and helpers for the two inspection tools (hidden-content reveal and the MCP
 * config check). Everything here is deterministic: the same input bytes always produce the
 * same findings, in the same order. No model, no randomness, no clock.
 *
 * Inspected content is data. Nothing in this directory executes, renders, decodes-and-runs
 * or follows anything it reads; quoted content is sanitized (invisible and control
 * characters spelled out as <U+XXXX>) and length-bounded before it leaves the module.
 */

export type FindingLabel = "deterministic" | "heuristic";

export interface Location {
  /** 1-based line and column (columns count UTF-16 code units, like editors do). */
  line: number;
  column: number;
  /** 0-based offset into the decoded input. */
  offset: number;
}

export interface FindingItem {
  /** Sanitized, bounded quote of the content the rule matched. Never interpreted. */
  quote: string;
  /** Where it was found: a position in the input, or a path in a JSON config. */
  location: Location | { path: string };
  /** One sentence: what this is, or how to fix it. */
  explanation: string;
  /** Rule-specific facts (codepoints, lengths, hostnames...). Plain JSON values only. */
  details?: Record<string, unknown>;
}

export interface RuleFindings {
  rule: string;
  title: string;
  label: FindingLabel;
  informational: boolean;
  /** Set on informational rules: what one listed item is, singular and plural. */
  itemNoun?: [string, string];
  /** How many matches the rule found in total. */
  count: number;
  /** True when `items` stops before `count` because of the per-rule cap. */
  truncated: boolean;
  items: FindingItem[];
  /** Rule-level facts, e.g. a per-codepoint tally. */
  details?: Record<string, unknown>;
}

export interface CheckInfo {
  rule: string;
  title: string;
  label: FindingLabel;
  /** Neutral inventory (outbound hosts, accessibility text): listed, never counted as a finding. */
  informational?: boolean;
  /** For informational checks: what one listed item is, singular and plural ("outbound host"). */
  itemNoun?: [string, string];
}

/** Collects matches for one rule, keeping at most `cap` items and counting the rest. */
export class RuleCollector {
  readonly items: FindingItem[] = [];
  count = 0;
  details: Record<string, unknown> | undefined;
  constructor(
    readonly check: CheckInfo,
    readonly cap: number,
  ) {}
  add(item: FindingItem): void {
    this.count += 1;
    if (this.items.length < this.cap) this.items.push(item);
  }
  /** Counts `n` more matches that weren't individually listed (e.g. a codepoint tally). */
  addUnlisted(n: number): void {
    this.count += n;
  }
  result(): RuleFindings | null {
    if (this.count === 0) return null;
    return { rule: this.check.rule, title: this.check.title, label: this.check.label, informational: this.check.informational ?? false, ...(this.check.itemNoun ? { itemNoun: this.check.itemNoun } : {}), count: this.count, truncated: this.items.length < this.count, items: this.items, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Characters spelled out in quotes instead of being passed through: C0/C1 controls (except
 * tab/newline, which become spaces), zero-width and other invisible format characters, bidi
 * controls, tag characters, variation selectors, private-use and unpaired surrogates. */
const SPELL_OUT =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻-]|[\uDB40][\uDC00-\uDDEF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function codepointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Makes `text` printable and bounded. Invisible characters become `<U+XXXX>`, runs of
 * whitespace collapse to one space, and anything past `max` characters is cut with "…". */
export function quote(text: string, max = 160): string {
  const visible = text.replace(SPELL_OUT, (ch) => `<${codepointLabel(ch.codePointAt(0)!)}>`).replace(/\s+/g, " ").trim();
  if (visible.length <= max) return visible;
  // Don't cut a <U+XXXX> marker or a surrogate pair in half.
  let cut = visible.slice(0, max);
  const open = cut.lastIndexOf("<U+");
  if (open !== -1 && cut.indexOf(">", open) === -1) cut = cut.slice(0, open);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Maps offsets in a string to 1-based line/column. Built once per input. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  at(offset: number): Location {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.starts[lo]! + 1, offset };
  }
}

/** Report headline: "N findings across M checks" — never "clean" or "safe". Informational
 * inventories are not findings and go on their own line (see `informationalLine`). */
export function summaryLine(findings: RuleFindings[], checksRun: number): string {
  const total = findings.filter((f) => !f.informational).reduce((n, f) => n + f.count, 0);
  const checks = `${checksRun} check${checksRun === 1 ? "" : "s"}`;
  if (total === 0) return `No findings across ${checks}.`;
  return `${total} finding${total === 1 ? "" : "s"} across ${checks}.`;
}

/** The smaller line under the headline: "2 outbound hosts listed for information." Null when
 * no informational rule matched. */
export function informationalLine(findings: RuleFindings[]): string | null {
  const listed = findings
    .filter((f) => f.informational)
    .map((f) => {
      const [one, many] = f.itemNoun ?? [f.title.toLowerCase(), f.title.toLowerCase()];
      return `${f.count} ${f.count === 1 ? one : many}`;
    });
  if (!listed.length) return null;
  const joined = listed.length === 1 ? listed[0] : `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}`;
  return `${joined} listed for information.`;
}

/** Deterministic error a caller can show as-is (bad input, too large, refused URL...). */
export class InspectError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "InspectError";
  }
}
