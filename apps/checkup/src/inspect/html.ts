import { Parser } from "htmlparser2";
import { type CheckInfo, type LineIndex, quote, RuleCollector } from "./common.js";
import { type RawReference, textReferences } from "./textChecks.js";

/**
 * HTML-only checks, from raw markup and inline styles alone. No layout is computed, no
 * stylesheet or script is fetched or run, nothing is rendered. Where visibility depends on
 * styles this module never saw, the finding says so.
 *
 * htmlparser2 is a tolerant streaming tokenizer: it never executes anything, handles
 * malformed markup without throwing, and works in linear time.
 */

const HIDDEN_SIGNALS = [
  ["display-none", "display:none"],
  ["visibility-hidden", "visibility:hidden"],
  ["opacity-zero", "opacity:0"],
  ["font-size-zero", "font-size:0"],
  ["offscreen", "off-screen positioning"],
  ["clipped", "clipped to nothing"],
  ["hidden-attribute", "the hidden attribute"],
] as const;
type Signal = (typeof HIDDEN_SIGNALS)[number][0];

export const HIDDEN_CHECKS: Record<Signal, CheckInfo> = Object.fromEntries(
  HIDDEN_SIGNALS.map(([id, label]) => [id, { rule: `hidden.${id}`, title: `Text hidden by ${label}`, label: "deterministic" } satisfies CheckInfo]),
) as Record<Signal, CheckInfo>;
export const CHECK_COMMENT: CheckInfo = { rule: "html.comment-text", title: "HTML comments with text", label: "deterministic" };
export const CHECK_DATA_ATTR: CheckInfo = { rule: "html.data-attribute-large", title: "Oversized data-* attributes", label: "deterministic" };
export const CHECK_META: CheckInfo = { rule: "html.meta-content", title: "Meta tag content", label: "deterministic" };
export const CHECK_A11Y: CheckInfo = { rule: "a11y.text-not-visible", title: "Accessibility text not otherwise visible", label: "deterministic", informational: true, itemNoun: ["item of accessibility text", "items of accessibility text"] };

export const DATA_ATTR_MIN_LENGTH = 256;
/** Element nesting deeper than this stops the markup checks (the tokenizer's cost grows with
 * depth, so a pathological document could otherwise take seconds). Text-level checks still
 * cover the whole input. */
export const MAX_NESTING_DEPTH = 1000;
const WRITE_CHUNK = 16 * 1024;
const MAX_HIDDEN_TEXT = 4000;
const A11Y_ATTRS = ["aria-label", "aria-description", "alt", "title"] as const;
/** Elements whose text content isn't page text. */
const NON_TEXT = new Set(["script", "style", "template", "head", "title", "noscript", "svg", "math"]);

/** Parses one CSS length; returns [number, unit] or null. */
function length(value: string): [number, string] | null {
  const m = /^(-?\d*\.?\d+)\s*([a-z%]*)$/.exec(value.trim());
  return m ? [Number(m[1]), m[2]!] : null;
}
const farNegative = (value: string) => {
  const l = length(value);
  if (!l) return false;
  const [n, unit] = l;
  if (unit === "px" || unit === "") return n <= -1000;
  if (unit === "em" || unit === "rem" || unit === "ch") return n <= -50;
  if (unit === "%" || unit === "vw" || unit === "vh") return n <= -100;
  return false;
};
const isZero = (value: string) => {
  const l = length(value);
  return !!l && l[0] === 0;
};

/** Reads an inline style attribute into the hidden signals it carries, in a fixed order. */
export function styleSignals(style: string): Signal[] {
  const decls = new Map<string, string>();
  for (const part of style.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .replace(/!\s*important/i, "")
      .trim()
      .toLowerCase();
    if (prop) decls.set(prop, value);
  }
  const found = new Set<Signal>();
  if (decls.get("display") === "none") found.add("display-none");
  const visibility = decls.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") found.add("visibility-hidden");
  if (decls.has("opacity") && isZero(decls.get("opacity")!)) found.add("opacity-zero");
  if (decls.has("font-size") && isZero(decls.get("font-size")!)) found.add("font-size-zero");
  for (const prop of ["left", "top", "right", "bottom", "margin-left", "margin-top", "text-indent", "inset-inline-start"]) {
    if (decls.has(prop) && farNegative(decls.get(prop)!)) found.add("offscreen");
  }
  const transform = decls.get("transform");
  if (transform && /translate[xy3d]?\(\s*-\d{4,}(?:\.\d+)?px/.test(transform)) found.add("offscreen");
  const clip = decls.get("clip");
  if (clip && /^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/.test(clip)) found.add("clipped");
  const clipPath = decls.get("clip-path");
  if (clipPath && /^(?:inset\(\s*(?:50|100)%\s*\)|circle\(\s*0(?:px|%)?\s*\))$/.test(clipPath)) found.add("clipped");
  const overflowHidden = decls.get("overflow") === "hidden";
  const tiny = (v: string | undefined) => v !== undefined && (isZero(v) || v === "1px");
  if (overflowHidden && ((tiny(decls.get("width")) && tiny(decls.get("height"))) || isZero(decls.get("max-height") ?? "x") || isZero(decls.get("max-width") ?? "x"))) {
    found.add("clipped");
  }
  return HIDDEN_SIGNALS.map(([id]) => id).filter((id) => found.has(id));
}

interface OpenElement {
  name: string;
  offset: number;
  /** Set on the outermost hidden element only. */
  hidden: { signals: Signal[]; tag: string; text: string[]; textLength: number } | null;
}

export interface HtmlFacts {
  collectors: RuleCollector[];
  references: RawReference[];
  /** What the page points at but this tool never fetched. */
  unfetched: { scripts: number; inlineScripts: number; stylesheets: number; styleBlocks: number; images: number; frames: number; other: number };
  /** Offset where markup checks stopped because nesting passed MAX_NESTING_DEPTH, or null. */
  stoppedAt: number | null;
}

export function htmlChecks(html: string, lines: LineIndex, cap: number): HtmlFacts {
  const hidden = Object.fromEntries(HIDDEN_SIGNALS.map(([id]) => [id, new RuleCollector(HIDDEN_CHECKS[id], cap)])) as Record<Signal, RuleCollector>;
  const comments = new RuleCollector(CHECK_COMMENT, cap);
  const dataAttrs = new RuleCollector(CHECK_DATA_ATTR, cap);
  const meta = new RuleCollector(CHECK_META, cap);
  const a11y = new RuleCollector(CHECK_A11Y, cap);
  const references: RawReference[] = [];
  const unfetched = { scripts: 0, inlineScripts: 0, stylesheets: 0, styleBlocks: 0, images: 0, frames: 0, other: 0 };
  const a11yCandidates: { value: string; tag: string; attr: string; offset: number }[] = [];
  const visible: string[] = [];

  const stack: OpenElement[] = [];
  let nonText = 0;
  let hiddenOwner: OpenElement | null = null;
  let comment = "";
  let commentStart = 0;
  let stoppedAt: number | null = null;

  const closeElement = (el: OpenElement) => {
    if (NON_TEXT.has(el.name)) nonText = Math.max(0, nonText - 1);
    if (el === hiddenOwner) {
      const text = el.hidden!.text.join("").replace(/\s+/g, " ").trim();
      if (text) {
        const [first] = el.hidden!.signals;
        const how = el.hidden!.signals.includes("hidden-attribute") && el.hidden!.signals.length === 1 ? "the hidden attribute" : "inline style";
        hidden[first!].add({
          quote: quote(text, 240),
          location: lines.at(el.offset),
          explanation: `Hidden by ${how}; external stylesheets not fetched, actual visibility unknown.`,
          details: { tag: quote(el.hidden!.tag, 160), signals: el.hidden!.signals, textLength: el.hidden!.textLength },
        });
      }
      hiddenOwner = null;
    }
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (stoppedAt !== null) return;
        const offset = parser.startIndex;
        if (stack.length >= MAX_NESTING_DEPTH) {
          stoppedAt = offset;
          return;
        }
        const el: OpenElement = { name, offset, hidden: null };
        if (NON_TEXT.has(name)) nonText += 1;

        // Things this tool never fetches.
        if (name === "script") attribs.src ? unfetched.scripts++ : unfetched.inlineScripts++;
        else if (name === "style") unfetched.styleBlocks++;
        else if (name === "link" && /\bstylesheet\b/i.test(attribs.rel ?? "")) unfetched.stylesheets++;
        else if (name === "img" || name === "picture" || name === "source") unfetched.images += attribs.src || attribs.srcset ? 1 : 0;
        else if (name === "iframe" || name === "frame" || name === "embed" || name === "object") unfetched.frames++;
        else if ((name === "link" || name === "video" || name === "audio") && (attribs.href || attribs.src)) unfetched.other++;

        for (const [attr, value] of Object.entries(attribs)) {
          if (attr === "href" || attr === "src" || attr === "action" || attr === "formaction") {
            if (value.trim()) references.push({ url: value.trim(), kind: `${attr} attribute`, offset });
          }
          if (attr.startsWith("data-") && value.length >= DATA_ATTR_MIN_LENGTH) {
            dataAttrs.add({
              quote: quote(value, 120),
              location: lines.at(offset),
              explanation: "A large data-* attribute carries content that isn't shown as page text; nothing in it was run.",
              details: { tag: name, attribute: attr, length: value.length },
            });
          }
          if ((A11Y_ATTRS as readonly string[]).includes(attr) && value.trim()) a11yCandidates.push({ value, tag: name, attr, offset });
        }
        if (name === "meta" && attribs.content !== undefined && attribs.content.trim()) {
          const key = attribs.name ?? attribs.property ?? attribs.itemprop ?? (attribs["http-equiv"] ? `http-equiv=${attribs["http-equiv"]}` : "(unnamed)");
          meta.add({
            quote: quote(attribs.content, 200),
            location: lines.at(offset),
            explanation: "Meta tag content is read by programs but not shown on the page.",
            details: { name: quote(key, 80) },
          });
        }

        if (!hiddenOwner) {
          const signals = styleSignals(attribs.style ?? "");
          if (attribs.hidden !== undefined && !signals.includes("hidden-attribute")) signals.push("hidden-attribute");
          if (signals.length) {
            const tag = html.slice(offset, Math.min(parser.endIndex + 1, offset + 400));
            el.hidden = { signals, tag, text: [], textLength: 0 };
            hiddenOwner = el;
          }
        }
        stack.push(el);
      },
      onclosetag(name) {
        if (stoppedAt !== null) return;
        // htmlparser2 closes implied and void elements itself, so the top normally matches.
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i]!.name === name) {
            while (stack.length > i) closeElement(stack.pop()!);
            break;
          }
        }
      },
      ontext(text) {
        if (stoppedAt !== null || nonText > 0) return;
        if (hiddenOwner) {
          const h = hiddenOwner.hidden!;
          h.textLength += text.length;
          const room = MAX_HIDDEN_TEXT - h.text.reduce((n, t) => n + t.length, 0);
          if (room > 0) h.text.push(text.slice(0, room));
          return;
        }
        visible.push(text);
        for (const ref of textReferences(text)) references.push({ ...ref, offset: parser.startIndex + ref.offset });
      },
      oncomment(data) {
        if (stoppedAt !== null) return;
        if (!comment) commentStart = parser.startIndex;
        comment += data;
      },
      oncommentend() {
        if (stoppedAt !== null) return;
        const text = comment.trim();
        if (text) {
          comments.add({
            quote: quote(text, 240),
            location: lines.at(commentStart),
            explanation: "HTML comments aren't shown on the page but are part of what a program reading the source sees.",
            details: { length: text.length },
          });
        }
        comment = "";
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  for (let i = 0; i < html.length && stoppedAt === null; i += WRITE_CHUNK) parser.write(html.slice(i, i + WRITE_CHUNK));
  if (stoppedAt === null) parser.end();
  while (stack.length) closeElement(stack.pop()!);

  // Accessibility text is information, never a flag: list what doesn't appear as visible text.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const visibleText = norm(visible.join(" "));
  const listed = new Set<string>();
  for (const c of a11yCandidates) {
    const value = norm(c.value);
    if (!value || visibleText.includes(value)) continue;
    const key = `${c.attr}\u0000${value}`;
    if (listed.has(key)) continue;
    listed.add(key);
    a11y.add({
      quote: quote(c.value, 200),
      location: lines.at(c.offset),
      explanation: "Text carried by an accessibility attribute that doesn't appear in the page's visible text; listed for information only.",
      details: { tag: c.tag, attribute: c.attr },
    });
  }

  return {
    collectors: [...HIDDEN_SIGNALS.map(([id]) => hidden[id]), comments, dataAttrs, meta, a11y],
    references,
    unfetched,
    stoppedAt,
  };
}
