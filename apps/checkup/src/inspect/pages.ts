import { esc, layout } from "../pages.js";
import type { FindingItem, RuleFindings } from "./common.js";
import type { ContentReport } from "./content.js";
import type { ConfigReport } from "./mcpConfig.js";

/**
 * Pages for the two inspection tools. Reports are rendered straight into the POST response
 * and never stored, so there is no report URL to share. Every value that came from the
 * input goes through `esc`, and the page's CSP allows no scripts at all.
 */

export const INSPECT_CSS = `
.tool-list { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.subhead { font-size: 17px; color: var(--ink-soft); margin: -4px 0 14px; }
form.inspect { display: grid; gap: 12px; margin: 20px 0; }
form.inspect textarea, form.inspect input[type=url] { width: 100%; font: inherit; font-family: var(--font-data); font-size: 14px; padding: 10px 12px; border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--bg-panel); color: var(--ink); }
form.inspect textarea { min-height: 260px; resize: vertical; }
form.inspect fieldset { border: 1px solid var(--rule); border-radius: var(--radius); padding: 10px 12px; display: flex; gap: 16px; flex-wrap: wrap; }
form.inspect legend { font-family: var(--font-ui); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-soft); padding: 0 4px; }
form.inspect button { justify-self: start; }
.rule { border-top: 1px solid var(--rule); padding-top: 12px; margin-top: 20px; }
.rule h3 { font-family: var(--font-display); font-weight: 600; font-size: 17px; margin: 0 0 4px; }
.tag { font-family: var(--font-ui); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-soft); border: 1px solid var(--rule); border-radius: var(--radius); padding: 1px 6px; margin-left: 6px; }
.item { margin: 10px 0 14px; }
.item .quote { display: block; font-family: var(--font-data); font-size: 13px; background: var(--bg-inset); border: 1px solid var(--rule); border-radius: var(--radius); padding: 8px 10px; overflow-wrap: anywhere; white-space: pre-wrap; }
.item .meta { font-family: var(--font-ui); font-size: 12px; color: var(--ink-soft); margin: 4px 0 0; }
.note { background: var(--bg-panel); border: 1px solid var(--rule); border-radius: var(--radius); padding: 12px 14px; }
ul.plain { padding-left: 18px; }
`;

const HEAD = `<link rel="stylesheet" href="/assets/inspect.css"><meta name="robots" content="noindex, nofollow">`;
const DESCRIPTION = "Inspection tools: reveal hidden content in HTML or text, and read an MCP client config before installing it. Deterministic, nothing stored.";
const page = (title: string, body: string) => layout(title, body, { description: DESCRIPTION, head: HEAD });

const PRIVACY = `<p>Nothing you paste or fetch here is stored: it is processed in memory for this one response and the report is shown only to you. There is no shareable report link.</p>`;

export function inspectIndexPage(): string {
  return page(
    "Inspection tools",
    `<p class="label">Inspection tools</p>
<h1>Read what's actually there.</h1>
<p>Two narrow, deterministic inspection tools. The same input always gives the same findings; no model is involved. Each finding quotes what it matched, says where, and explains it in a sentence. They describe what is present; they don't judge it.</p>
<div class="tool-list">
<div class="panel"><p class="label">Hidden content</p><h2 style="margin-top:0">What's hiding in this?</h2><p>Paste HTML or text, or give one URL. Lists invisible Unicode, text hidden by inline styles, comments, meta and data attributes, encoded blobs and outbound hosts.</p><p><a href="/inspect/content">Open</a></p></div>
<div class="panel"><p class="label">MCP config</p><h2 style="margin-top:0">Check this MCP setup before I install it</h2><p>Paste an MCP client config. Reads it statically for unpinned packages, download-and-run chains, plain http, broad file access, shell or privileged commands, auto-approved tools and credentials.</p><p><a href="/inspect/mcp-config">Open</a></p></div>
</div>
${PRIVACY}
<h2>From an agent</h2>
<p>Both tools are also on the OpenGlass public MCP endpoint as <code>inspect_hidden_content</code> and <code>check_mcp_config</code>, and as JSON at <code>POST /api/inspect/content</code> and <code>POST /api/inspect/mcp-config</code>.</p>`,
  );
}

export function contentFormPage(error?: string): string {
  return page(
    "What's hiding in this?",
    `<p class="label">Hidden content</p>
<h1>What's hiding in this?</h1>
<p>Paste HTML or plain text, or give one URL to fetch. A URL is fetched once, with no images, stylesheets, scripts or frames, and nothing is rendered or run. Up to 2 MB is read.</p>
${error ? `<p class="note"><strong>Couldn't inspect that:</strong> ${esc(error)}</p>` : ""}
<form class="inspect" method="post" action="/inspect/content">
<fieldset><legend>Input</legend>
<label><input type="radio" name="mode" value="html" checked> Pasted HTML</label>
<label><input type="radio" name="mode" value="text"> Pasted plain text</label>
<label><input type="radio" name="mode" value="url"> URL</label></fieldset>
<label class="label" for="content">Paste here (HTML or text)</label>
<textarea id="content" name="content" spellcheck="false" autocomplete="off"></textarea>
<label class="label" for="url">Or a URL (choose "URL" above)</label>
<input id="url" type="url" name="url" maxlength="2000" placeholder="https://example.com/page" autocomplete="off">
<button type="submit">Inspect</button>
</form>
${PRIVACY}`,
  );
}

export function configFormPage(error?: string): string {
  return page(
    "Check this MCP setup before I install it",
    `<p class="label">MCP config</p>
<h1>Check this MCP setup before I install it</h1>
<p>Paste an MCP client config: <code>{"mcpServers": {...}}</code>, a map of server names to server blocks, or a single server block. It is read as JSON and nothing else happens: no registry lookups, no downloads, nothing runs.</p>
<p class="note"><strong>Replace real credentials with placeholders before pasting</strong> (for example <code>"GITHUB_TOKEN": "&lt;token&gt;"</code>). Credential detection here is best-effort detection and redacts what it finds, but it will miss some.</p>
${error ? `<p class="note"><strong>Couldn't read that:</strong> ${esc(error)}</p>` : ""}
<form class="inspect" method="post" action="/inspect/mcp-config">
<label class="label" for="config">MCP config JSON</label>
<textarea id="config" name="config" spellcheck="false" autocomplete="off" required placeholder='{"mcpServers": {"example": {"command": "npx", "args": ["-y", "some-server@1.2.3"]}}}'></textarea>
<button type="submit">Check config</button>
</form>
${PRIVACY}`,
  );
}

function where(item: FindingItem): string {
  const loc = item.location;
  return "path" in loc ? esc(loc.path) : `line ${loc.line}, column ${loc.column}`;
}

function detailsLine(details: Record<string, unknown> | undefined): string {
  if (!details) return "";
  const parts = Object.entries(details).map(([k, v]) => `${esc(k)}: ${esc(typeof v === "string" ? v : JSON.stringify(v))}`);
  return parts.length ? `<p class="meta data">${parts.join(" · ")}</p>` : "";
}

function findingsHtml(findings: RuleFindings[]): string {
  if (!findings.length) return "";
  return findings
    .map(
      (f) => `<section class="rule"><h3>${esc(f.title)}<span class="tag">${esc(f.rule)}</span>${f.label === "heuristic" ? `<span class="tag">heuristic</span>` : ""}${f.informational ? `<span class="tag">information</span>` : ""}</h3>
<p class="meta">${f.count} match${f.count === 1 ? "" : "es"}${f.truncated ? `, showing the first ${f.items.length}` : ""}</p>
${f.details ? detailsLine(f.details) : ""}
${f.items
  .map(
    (i) => `<div class="item"><span class="quote">${esc(i.quote)}</span><p class="meta">${where(i)}</p><p style="margin:4px 0">${esc(i.explanation)}</p>${detailsLine(i.details)}</div>`,
  )
  .join("\n")}</section>`,
    )
    .join("\n");
}

function checksHtml(checks: { rule: string; title: string; label: string }[]): string {
  return `<ul class="plain">${checks.map((c) => `<li>${esc(c.title)} <code>${esc(c.rule)}</code>${c.label === "heuristic" ? " (heuristic)" : ""}</li>`).join("")}</ul>`;
}

export function contentReportPage(report: ContentReport): string {
  const i = report.input;
  const f = i.fetch;
  const source = f
    ? `<p>Fetched <code>${esc(f.url)}</code>${f.redirects.length ? ` (final URL <code>${esc(f.finalUrl)}</code> after ${f.redirects.length} redirect${f.redirects.length === 1 ? "" : "s"})` : ""}: status ${f.status}, ${esc(f.contentType ?? "no content type")}${f.contentEncoding ? `, ${esc(f.contentEncoding)}-encoded` : ""}.</p>`
    : `<p>Pasted ${i.kind === "html" ? "HTML" : "plain text"}.</p>`;
  const u = report.limits.unfetched;
  const unfetched = u
    ? `<li>Not fetched or run: ${u.scripts} external scripts, ${u.inlineScripts} inline scripts, ${u.stylesheets} stylesheets, ${u.styleBlocks} &lt;style&gt; blocks, ${u.images} images, ${u.frames} frames or embeds, ${u.other} other media.</li>`
    : "";
  return page(
    "Hidden content report",
    `<p class="label">Hidden content report</p>
<h1>${esc(report.summary)}</h1>
${report.informational ? `<p class="subhead">${esc(report.informational)}</p>` : ""}
${source}
<h2>Findings</h2>
${report.findings.length ? findingsHtml(report.findings) : `<p>${esc(report.summary)}</p>`}
<h2>Limits applied</h2>
<ul class="plain">
<li>Bytes read: ${i.bytesRead}${i.truncated ? ` (cut at ${report.limits.maxInputBytes}; the rest was not inspected)` : ", not truncated"}.</li>
<li>At most ${report.limits.perRuleCap} items listed per rule; the heuristic lists at most ${report.limits.heuristicCap}.</li>
${unfetched}
${report.limits.notes.map((n) => `<li>${esc(n)}</li>`).join("")}
</ul>
<p class="note">Heuristic matches are ${esc(report.heuristicWording)}</p>
<h2>Checks that ran</h2>
${checksHtml(report.checksRun)}
<p><a href="/inspect/content">Inspect something else</a></p>`,
  );
}

export function configReportPage(report: ConfigReport): string {
  const i = report.input;
  return page(
    "MCP config report",
    `<p class="label">MCP config report</p>
<h1>${esc(report.summary)}</h1>
<p class="note">${esc(report.note)}</p>
<p>Read ${i.analyzedServers} of ${i.servers} server${i.servers === 1 ? "" : "s"} (${esc(i.shape)} format, ${i.bytes} bytes).</p>
<h2>Findings</h2>
${report.findings.length ? findingsHtml(report.findings) : `<p>${esc(report.summary)}</p>`}
<h2>Limits applied</h2>
<ul class="plain">
<li>At most ${report.limits.perRuleCap} items listed per rule; at most ${report.limits.maxServers} servers read.</li>
${report.limits.notes.map((n) => `<li>${esc(n)}</li>`).join("")}
<li>${esc(report.secretsNote)}</li>
</ul>
<h2>Checks that ran</h2>
${checksHtml(report.checksRun)}
<p><a href="/inspect/mcp-config">Check another config</a></p>`,
  );
}
