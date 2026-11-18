import { type CheckInfo, InspectError, LineIndex, quote, RuleCollector, type RuleFindings, summaryLine } from "./common.js";
import { HIDDEN_CHECKS, CHECK_A11Y, CHECK_COMMENT, CHECK_DATA_ATTR, CHECK_META, DATA_ATTR_MIN_LENGTH, MAX_NESTING_DEPTH, htmlChecks, type HtmlFacts } from "./html.js";
import { HEURISTIC_WORDING } from "./heuristicPatterns.js";
import {
  BASE64_MIN_LENGTH,
  CHECK_BASE64,
  CHECK_BIDI,
  CHECK_HEURISTIC,
  CHECK_TAGS,
  CHECK_ZERO_WIDTH,
  HEURISTIC_CAP,
  base64Check,
  heuristicCheck,
  type RawReference,
  textReferences,
  unicodeChecks,
} from "./textChecks.js";

/**
 * Tool 1, "What's hiding in this?": runs the deterministic checks (and one labeled,
 * capped heuristic) over pasted HTML, pasted plain text, or the body of one fetched URL.
 */

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PER_RULE_CAP = 25;

export const CHECK_REFS: CheckInfo = { rule: "refs.outbound-hosts", title: "Outbound reference inventory", label: "deterministic", informational: true };

export type ContentKind = "html" | "text";

export interface FetchFacts {
  url: string;
  finalUrl: string;
  redirects: string[];
  status: number;
  contentType: string | null;
  /** Bytes as received on the wire before decompression, when known. */
  compressedBytes: number | null;
  contentEncoding: string | null;
}

export interface ContentReport {
  tool: "hidden-content";
  version: 1;
  input: {
    kind: ContentKind;
    source: "pasted" | "url";
    bytesRead: number;
    truncated: boolean;
    fetch?: FetchFacts;
  };
  summary: string;
  checksRun: CheckInfo[];
  findings: RuleFindings[];
  limits: {
    maxInputBytes: number;
    perRuleCap: number;
    heuristicCap: number;
    base64MinLength: number;
    dataAttributeMinLength: number;
    unfetched: HtmlFacts["unfetched"] | null;
    maxNestingDepth: number;
    notes: string[];
  };
  heuristicWording: string;
}

/** Cuts a UTF-8 buffer at `max` bytes without splitting a character. */
export function capUtf8(bytes: Buffer, max: number): { text: string; bytesRead: number; truncated: boolean } {
  if (bytes.length <= max) return { text: bytes.toString("utf8"), bytesRead: bytes.length, truncated: false };
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), bytesRead: end, truncated: true };
}

export interface InspectContentInput {
  kind: ContentKind;
  /** The raw bytes: pasted text encoded as UTF-8, or a fetched body. */
  bytes: Buffer;
  /** Set when the bytes were already cut short upstream (fetch byte cap). */
  truncatedUpstream?: boolean;
  /** Decodes `bytes` (fetched bodies may declare another charset). Defaults to UTF-8. */
  decode?: (bytes: Buffer) => string;
  fetch?: FetchFacts;
  perRuleCap?: number;
}

export function inspectContent(input: InspectContentInput): ContentReport {
  if (input.kind !== "html" && input.kind !== "text") throw new InspectError("bad_kind", 'kind must be "html" or "text"');
  const cap = input.perRuleCap ?? DEFAULT_PER_RULE_CAP;
  let bytes = input.bytes;
  let truncated = input.truncatedUpstream ?? false;
  if (bytes.length > MAX_INPUT_BYTES) {
    bytes = bytes.subarray(0, MAX_INPUT_BYTES);
    truncated = true;
  }
  const decoded = input.decode ? input.decode(bytes) : capUtf8(bytes, MAX_INPUT_BYTES).text;
  // A cut can leave half a character at the end; drop a trailing replacement character.
  const text = truncated ? decoded.replace(/�$/, "") : decoded;
  const lines = new LineIndex(text);

  const collectors: RuleCollector[] = [];
  const checks: CheckInfo[] = [CHECK_ZERO_WIDTH, CHECK_BIDI, CHECK_TAGS];
  collectors.push(...unicodeChecks(text, lines, cap, { html: input.kind === "html" }));

  let html: HtmlFacts | null = null;
  let references: RawReference[];
  if (input.kind === "html") {
    html = htmlChecks(text, lines, cap);
    checks.push(...Object.values(HIDDEN_CHECKS), CHECK_COMMENT, CHECK_DATA_ATTR, CHECK_META, CHECK_A11Y);
    collectors.push(...html.collectors);
    references = html.references;
  } else {
    references = textReferences(text);
  }
  checks.push(CHECK_BASE64, CHECK_REFS, CHECK_HEURISTIC);
  collectors.push(base64Check(text, lines, cap), referenceInventory(references, lines, cap, input.fetch?.finalUrl ?? null), heuristicCheck(text, lines));

  const findings = collectors.map((c) => c.result()).filter((f): f is RuleFindings => f !== null);
  const notes: string[] = [];
  if (input.kind === "html") {
    notes.push("Hidden-text checks read raw markup and inline style attributes only. No layout was computed, <style> blocks and external stylesheets were not applied, and no script ran, so actual visibility is unknown.");
    notes.push("Color and contrast are not checked.");
  }
  if (html?.stoppedAt != null) {
    const at = lines.at(html.stoppedAt);
    notes.push(`Element nesting passed ${MAX_NESTING_DEPTH} levels at line ${at.line}, column ${at.column}; markup checks (hidden text, comments, attributes, meta, accessibility, references) stopped there. The Unicode, encoded-run and heuristic checks still covered the whole input.`);
  }
  if (input.fetch) notes.push("Only the one URL was fetched. No subresources, images, stylesheets, scripts or frames were requested, and no browser was used.");
  else notes.push("Nothing was fetched.");
  if (truncated) notes.push(`Input was cut at ${MAX_INPUT_BYTES} bytes; content after that was not inspected.`);
  notes.push("Inputs and reports are processed in memory for this response only and are not stored.");

  return {
    tool: "hidden-content",
    version: 1,
    input: { kind: input.kind, source: input.fetch ? "url" : "pasted", bytesRead: bytes.length, truncated, ...(input.fetch ? { fetch: input.fetch } : {}) },
    summary: summaryLine(findings, checks.length),
    checksRun: checks,
    findings,
    limits: {
      maxInputBytes: MAX_INPUT_BYTES,
      perRuleCap: cap,
      heuristicCap: HEURISTIC_CAP,
      base64MinLength: BASE64_MIN_LENGTH,
      dataAttributeMinLength: DATA_ATTR_MIN_LENGTH,
      unfetched: html?.unfetched ?? null,
      maxNestingDepth: MAX_NESTING_DEPTH,
      notes,
    },
    heuristicWording: HEURISTIC_WORDING,
  };
}

/** One item per distinct host, most-referenced first. An inventory, nothing more. */
function referenceInventory(refs: RawReference[], lines: LineIndex, cap: number, pageUrl: string | null): RuleCollector {
  const out = new RuleCollector(CHECK_REFS, cap);
  const pageHost = pageUrl ? hostOf(pageUrl) : null;
  const hosts = new Map<string, { count: number; kinds: Set<string>; schemes: Set<string>; first: number }>();
  for (const ref of refs) {
    const key = hostKey(ref.url);
    if (!key) continue;
    const entry = hosts.get(key.host) ?? { count: 0, kinds: new Set(), schemes: new Set(), first: ref.offset };
    entry.count += 1;
    entry.kinds.add(ref.kind);
    entry.schemes.add(key.scheme);
    entry.first = Math.min(entry.first, ref.offset);
    hosts.set(key.host, entry);
  }
  const sorted = [...hosts.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [host, e] of sorted) {
    out.add({
      quote: quote(host, 200),
      location: lines.at(e.first),
      explanation:
        host === pageHost
          ? "Referenced host, the same one the page was fetched from; listed as an inventory, nothing was fetched."
          : "Referenced host; listed as an inventory, not an accusation, and nothing was fetched.",
      details: { references: e.count, kinds: [...e.kinds].sort(), schemes: [...e.schemes].sort() },
    });
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Host of an absolute URL; relative references and fragment links group under labels. */
function hostKey(raw: string): { host: string; scheme: string } | null {
  const url = raw.trim();
  if (!url || url.startsWith("#")) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]{0,30}):/.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return url.startsWith("//") ? hostFromAbsolute(`https:${url}`, "https") : { host: "(relative references)", scheme: "relative" };
  if (scheme === "http" || scheme === "https" || scheme === "ftp" || scheme === "ws" || scheme === "wss") return hostFromAbsolute(url, scheme);
  if (scheme === "mailto") {
    const domain = /@([^?&>\s]+)/.exec(url)?.[1]?.toLowerCase();
    return { host: domain ? `${domain} (mailto)` : "(mailto: addresses)", scheme };
  }
  return { host: `(${scheme}: URLs)`, scheme };
}

function hostFromAbsolute(url: string, scheme: string): { host: string; scheme: string } | null {
  const host = hostOf(url);
  return host ? { host, scheme } : { host: "(unparseable URLs)", scheme };
}
