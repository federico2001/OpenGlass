import { HEURISTIC_PATTERNS, HEURISTIC_WORDING } from "./heuristicPatterns.js";
import { type CheckInfo, codepointLabel, type LineIndex, quote, RuleCollector } from "./common.js";

/**
 * The checks that run on any text, HTML or plain: invisible Unicode, encoded blobs, the
 * pattern-matched "reads like it addresses an AI reader" heuristic, and markdown/bare-URL
 * references. Each takes the decoded input and a LineIndex, and returns collectors.
 */

export const CHECK_ZERO_WIDTH: CheckInfo = { rule: "unicode.zero-width", title: "Zero-width and invisible format characters", label: "deterministic" };
export const CHECK_BIDI: CheckInfo = { rule: "unicode.bidi-control", title: "Bidirectional overrides and isolates", label: "deterministic" };
export const CHECK_TAGS: CheckInfo = { rule: "unicode.tag-characters", title: "Unicode tag characters", label: "deterministic" };
export const CHECK_BASE64: CheckInfo = { rule: "encoded.base64-run", title: "Long base64-looking runs", label: "deterministic" };
export const CHECK_HEURISTIC: CheckInfo = { rule: "heuristic.ai-addressed-text", title: "Text that reads like it addresses an AI reader", label: "heuristic" };

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff, 0x180e]);
const BIDI = new Set([0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);
const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;

type UnicodeClass = "zw" | "bidi" | "tag";
function classify(cp: number, offset: number): UnicodeClass | null {
  if (ZERO_WIDTH.has(cp)) return cp === 0xfeff && offset === 0 ? null : "zw"; // a leading BOM is a file marker
  if (BIDI.has(cp)) return "bidi";
  if (isTag(cp)) return "tag";
  return null;
}

const EXPLAIN: Record<UnicodeClass, string> = {
  zw: "Zero-width characters take no space on screen, so text carrying them reads differently to a program than it looks to a person.",
  bidi: "Bidirectional controls change the display order of the text around them, so what is shown can differ from the stored character order.",
  tag: "Tag characters are invisible in most fonts and can spell out ASCII text that a person can't see; the decoded text is shown here for reading only.",
};

const CONTEXT = 24;

const ENTITY = /&#(?:[xX]([0-9a-fA-F]{1,6})|(\d{1,7}));?|&(ZeroWidthSpace|zwj|zwnj|NegativeThinSpace|NegativeMediumSpace|NegativeThickSpace|NegativeVeryThinSpace|NoBreak|InvisibleTimes|InvisibleComma|ApplyFunction|af|it|ic);/g;
const NAMED: Record<string, number> = {
  ZeroWidthSpace: 0x200b, NegativeThinSpace: 0x200b, NegativeMediumSpace: 0x200b, NegativeThickSpace: 0x200b, NegativeVeryThinSpace: 0x200b,
  zwj: 0x200d, zwnj: 0x200c, NoBreak: 0x2060, ApplyFunction: 0x2061, af: 0x2061, InvisibleTimes: 0x2062, it: 0x2062, InvisibleComma: 0x2063, ic: 0x2063,
};

/** `html`: also count invisible characters written as character references (&#x200B;,
 * &zwj;...), which a browser decodes but a raw scan wouldn't see. */
export function unicodeChecks(text: string, lines: LineIndex, cap: number, opts: { html?: boolean } = {}): RuleCollector[] {
  const collectors: Record<UnicodeClass, RuleCollector> = {
    zw: new RuleCollector(CHECK_ZERO_WIDTH, cap),
    bidi: new RuleCollector(CHECK_BIDI, cap),
    tag: new RuleCollector(CHECK_TAGS, cap),
  };
  const tallies: Record<UnicodeClass, Record<string, number>> = { zw: {}, bidi: {}, tag: {} };
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const cls = classify(cp, i);
    if (!cls) {
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    // Group a run of same-class characters into one item.
    const start = i;
    const codepoints: Record<string, number> = {};
    let decoded = "";
    while (i < text.length) {
      const c = text.codePointAt(i)!;
      if (classify(c, i) !== cls) break;
      const label = codepointLabel(c);
      codepoints[label] = (codepoints[label] ?? 0) + 1;
      tallies[cls][label] = (tallies[cls][label] ?? 0) + 1;
      if (cls === "tag" && c >= 0xe0020 && c <= 0xe007e) decoded += String.fromCharCode(c - 0xe0000);
      i += c > 0xffff ? 2 : 1;
    }
    const before = text.slice(Math.max(0, start - CONTEXT), start);
    const after = text.slice(i, i + CONTEXT);
    collectors[cls].add({
      quote: quote(`${before}${text.slice(start, i)}${after}`, 200),
      location: lines.at(start),
      explanation: EXPLAIN[cls],
      details: {
        codepoints,
        length: Object.values(codepoints).reduce((a, b) => a + b, 0),
        ...(cls === "tag" && decoded ? { decodedTagText: quote(decoded, 160) } : {}),
      },
    });
  }
  if (opts.html) {
    for (const m of text.matchAll(ENTITY)) {
      const cp = m[1] ? parseInt(m[1], 16) : m[2] ? parseInt(m[2], 10) : NAMED[m[3]!]!;
      const cls = classify(cp, -1);
      if (!cls) continue;
      const label = codepointLabel(cp);
      tallies[cls][label] = (tallies[cls][label] ?? 0) + 1;
      const start = m.index!;
      collectors[cls].add({
        quote: quote(text.slice(Math.max(0, start - CONTEXT), start + m[0].length + CONTEXT), 200),
        location: lines.at(start),
        explanation: `${EXPLAIN[cls]} Here it is written as an HTML character reference.`,
        details: { codepoints: { [label]: 1 }, length: 1, characterReference: m[0] },
      });
    }
  }
  for (const cls of Object.keys(collectors) as UnicodeClass[]) {
    if (collectors[cls].count > 0) collectors[cls].details = { codepointTotals: tallies[cls] };
  }
  return [collectors.zw, collectors.bidi, collectors.tag];
}

/** Base64 (standard or URL-safe) runs at least this long are reported. */
export const BASE64_MIN_LENGTH = 80;
const BASE64_RUN = /[A-Za-z0-9+/_-]{80,}={0,2}/g;
const SNIFF_BYTES = 48;

/** Reports location and length only. A short prefix is decoded and shown when every byte of
 * it is printable ASCII, so a reader can tell text from binary; nothing is ever run. */
export function base64Check(text: string, lines: LineIndex, cap: number): RuleCollector {
  const out = new RuleCollector(CHECK_BASE64, cap);
  for (const m of text.matchAll(BASE64_RUN)) {
    const run = m[0];
    // Real base64 mixes cases and digits; long words, hex and dashes-only runs don't.
    if (!/[A-Z]/.test(run) || !/[a-z]/.test(run) || !/[0-9]/.test(run)) continue;
    const prefix = run.slice(0, Math.ceil((SNIFF_BYTES * 4) / 3)).replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Buffer.from(prefix, "base64").subarray(0, SNIFF_BYTES);
    const printable = bytes.length > 0 && bytes.every((b) => (b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d);
    out.add({
      quote: quote(run, 48),
      location: lines.at(m.index!),
      explanation: "A long base64-looking run; its content isn't shown in full or decoded beyond a short printable prefix, and nothing in it is run.",
      details: { length: run.length, ...(printable ? { printablePrefix: quote(bytes.toString("latin1"), SNIFF_BYTES) } : { printablePrefix: null }) },
    });
  }
  return out;
}

export const HEURISTIC_CAP = 10;

export function heuristicCheck(text: string, lines: LineIndex): RuleCollector {
  const out = new RuleCollector(CHECK_HEURISTIC, HEURISTIC_CAP);
  const hits: { index: number; end: number; pattern: string }[] = [];
  for (const p of HEURISTIC_PATTERNS) {
    for (const m of text.matchAll(p.regex)) hits.push({ index: m.index!, end: m.index! + m[0].length, pattern: p.id });
  }
  // Same order whatever the pattern order: by position, then pattern id. Overlapping matches
  // of different patterns at the same spot count once.
  hits.sort((a, b) => a.index - b.index || a.pattern.localeCompare(b.pattern));
  let lastEnd = -1;
  for (const h of hits) {
    if (h.index < lastEnd) continue;
    lastEnd = h.end;
    const start = Math.max(0, h.index - 40);
    out.add({
      quote: quote(text.slice(start, Math.min(text.length, h.end + 60)), 200),
      location: lines.at(h.index),
      explanation: HEURISTIC_WORDING,
      details: { pattern: h.pattern },
    });
  }
  return out;
}

const MARKDOWN_LINK = /\[[^\]\n]{0,500}\]\(\s*<?([^)\s>]{1,2048})>?(?:\s+"[^"\n]{0,500}")?\s*\)/g;
const AUTOLINK = /<((?:https?|ftp|mailto):[^>\s]{1,2048})>/gi;
const BARE_URL = /\b(?:https?|ftp):\/\/[^\s<>"'`)\]]{1,2048}/gi;

export interface RawReference {
  url: string;
  kind: string;
  offset: number;
}

/** Markdown links, autolinks and bare URLs in text. */
export function textReferences(text: string): RawReference[] {
  const refs: RawReference[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    refs.push({ url: m[1]!, kind: "markdown link", offset: m.index! });
    seen.add(m.index! + m[0].indexOf(m[1]!));
  }
  for (const m of text.matchAll(AUTOLINK)) {
    refs.push({ url: m[1]!, kind: "autolink", offset: m.index! });
    seen.add(m.index! + 1);
  }
  for (const m of text.matchAll(BARE_URL)) {
    if (seen.has(m.index!)) continue;
    refs.push({ url: m[0].replace(/[.,;:!?]+$/, ""), kind: "bare URL", offset: m.index! });
  }
  return refs;
}
