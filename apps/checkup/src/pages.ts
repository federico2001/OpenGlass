import type { Report, SectionName } from "./report.js";
import { SECTION_NAMES, witnessLine } from "./report.js";

/** Server-rendered pages, Clear Channel tokens (served from apps/web's tokens.css). Every
 * value that came from a target or a caller goes through `esc`. */

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MARK = `<svg width="28" height="28" viewBox="0 0 96 96" fill="none" aria-hidden="true">
<rect x="12" y="12" width="54" height="54" rx="2" stroke="currentColor" stroke-width="5"/>
<rect x="30" y="30" width="54" height="54" rx="2" stroke="currentColor" stroke-width="5"/>
<path d="M30 30 H66 V66 H30 Z" style="fill: var(--og-signal-green)" fill-opacity="0.7"/></svg>`;

export const SITE_CSS = `
@font-face { font-family: "Manrope"; font-weight: 400; font-display: swap; src: url(/assets/fonts/manrope-latin-400-normal.woff2) format("woff2"); }
@font-face { font-family: "Manrope"; font-weight: 600; font-display: swap; src: url(/assets/fonts/manrope-latin-600-normal.woff2) format("woff2"); }
@font-face { font-family: "Manrope"; font-weight: 800; font-display: swap; src: url(/assets/fonts/manrope-latin-800-normal.woff2) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-weight: 400; font-display: swap; src: url(/assets/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2"); }
@font-face { font-family: "IBM Plex Mono"; font-weight: 500; font-display: swap; src: url(/assets/fonts/ibm-plex-mono-latin-500-normal.woff2) format("woff2"); }
@font-face { font-family: "Fragment Mono"; font-weight: 400; font-display: swap; src: url(/assets/fonts/fragment-mono-latin-400-normal.woff2) format("woff2"); }
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--ink); }
body { margin: 0; font-family: var(--font-body); line-height: 1.55; }
.wrap { max-width: var(--page-width); margin: 0 auto; padding: 24px 16px 64px; }
header.top { display: flex; align-items: center; gap: 10px; padding-bottom: 20px; border-bottom: 1px solid var(--rule); margin-bottom: 28px; }
header.top a { color: var(--ink); text-decoration: none; font-family: var(--font-display); font-weight: 800; }
.label { font-family: var(--font-ui); font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-soft); margin: 0 0 6px; }
h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(26px, 5vw, 38px); line-height: 1.15; margin: 0 0 12px; overflow-wrap: anywhere; }
h2 { font-family: var(--font-display); font-weight: 600; font-size: 20px; margin: 32px 0 10px; }
p { max-width: var(--measure); }
a { color: var(--accent-text); overflow-wrap: anywhere; }
code, .data { font-family: var(--font-data); font-size: 14px; overflow-wrap: anywhere; }
pre { font-family: var(--font-data); font-size: 13px; background: var(--bg-inset); border: 1px solid var(--rule); border-radius: var(--radius); padding: 14px; overflow-x: auto; max-height: 520px; }
.panel { background: var(--bg-panel); border: 1px solid var(--rule); border-radius: var(--radius); padding: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.score { font-family: var(--font-display); font-weight: 800; font-size: 30px; margin: 0; }
.section { border-top: 1px solid var(--rule); padding: 14px 0; display: grid; grid-template-columns: 110px 80px 1fr; gap: 12px; align-items: baseline; }
@media (max-width: 560px) { .section { grid-template-columns: 1fr 1fr; } .section .summary { grid-column: 1 / -1; } }
.section .name { font-family: var(--font-ui); font-weight: 500; }
.section .value { font-family: var(--font-display); font-weight: 800; }
ol.fixes li { margin-bottom: 8px; }
.sev { font-family: var(--font-ui); font-size: 12px; text-transform: uppercase; color: var(--ink-soft); margin-right: 6px; }
.sev.high { color: var(--danger); }
form.check { display: flex; gap: 8px; flex-wrap: wrap; margin: 20px 0; }
form.check input { flex: 1 1 260px; font: inherit; font-family: var(--font-data); padding: 10px 12px; border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--bg-panel); color: var(--ink); }
button { font: inherit; font-family: var(--font-ui); font-weight: 500; padding: 10px 16px; border: 0; border-radius: var(--radius); background: var(--accent); color: var(--inverse-ink); cursor: pointer; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font-family: var(--font-ui); font-weight: 500; font-size: 12px; text-transform: uppercase; color: var(--ink-soft); }
.table-scroll { overflow-x: auto; }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--rule); color: var(--ink-soft); font-size: 14px; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Checks an A2A agent's card, endpoint, x402 and public identity, and records each checkup on OpenGlass.">
<link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/site.css">
</head><body><div class="wrap">
<header class="top">${MARK}<a href="/">Agent Checkup</a><span class="label" style="margin:0 0 0 auto">by OpenGlass</span></header>
${body}
<footer>Agent Checkup is built on <a href="https://openglass.glass">OpenGlass</a>, a neutral witness for agent-to-agent interactions. Agent card: <a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>.</footer>
</div></body></html>`;
}

export function landingPage(publicUrl: string): string {
  return layout(
    "Agent Checkup",
    `<p class="label">A2A agent checkup</p>
<h1>Check an A2A agent from the outside.</h1>
<p>Give it an agent-card URL or a domain. It validates the card against the current A2A schema, sends the agent one harmless test message, checks for a well-formed 402 if the card claims x402, and reads public identity signals. You get a score per section and the top three fixes.</p>
<form class="check" action="/check" method="get">
<input name="target" required maxlength="2000" placeholder="example.com or https://example.com/.well-known/agent-card.json" aria-label="Agent-card URL or domain">
<button type="submit">Run checkup</button></form>
<h2>From another agent</h2>
<p>Agent Checkup is itself an A2A agent. Send <code>message/send</code> (A2A 0.3) or <code>SendMessage</code> (A2A 1.0) to <code>${esc(publicUrl)}/a2a</code> with the target as text:</p>
<pre>curl -s ${esc(publicUrl)}/a2a -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": { "message": { "kind": "message", "messageId": "1", "role": "user",
    "parts": [ { "kind": "text", "text": "example.com" } ] } } }'</pre>
<h2>What it records</h2>
<p>Each checkup is recorded on OpenGlass as a signed, hash-chained attestation: the request, each check result, and the report. Every report links to that record so anyone can verify it offline. The agent being checked needs nothing from OpenGlass. Results are cached for an hour.</p>`,
  );
}

export function messagePage(title: string, message: string, status = ""): string {
  return layout(title, `<p class="label">${esc(status)}</p><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Run another checkup</a></p>`);
}

const LABELS: Record<SectionName, string> = { card: "Card", endpoint: "Endpoint", x402: "x402", identity: "Identity" };

export function reportPage(report: Report, record: { status: "issued" | "pending" | "none"; recordId: string | null }): string {
  const target = report.target.cardUrl ?? report.target.origin;
  const sections = SECTION_NAMES.map((name) => {
    const s = report.sections[name];
    return `<div class="section"><span class="name">${LABELS[name]}</span><span class="value">${s.score === null ? "n/a" : `${s.score}`}</span><span class="summary">${esc(s.summary)}</span></div>`;
  }).join("\n");
  const fixes = report.topFixes.length
    ? `<ol class="fixes">${report.topFixes.map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span>${esc(f.fix)}</li>`).join("")}</ol>`
    : "<p>Nothing to fix.</p>";
  const og = report.openglass;
  const ogLine =
    og.status === "unclaimed"
      ? `<p>OpenGlass profile: unclaimed — claim it to add a verified domain: <a href="${esc(og.claimLink)}">${esc(og.claimLink)}</a></p>`
      : og.status === "registered"
        ? `<p>${esc(og.line.replace(/: https?:\/\/\S+$/, ""))}: <a href="${esc(og.profileUrl)}">${esc(og.profileUrl)}</a></p>`
        : og.line
          ? `<p>${esc(og.line)}</p>`
          : "";
  const v = report.verification;
  const verification =
    v.status === "recorded"
      ? `<p>This checkup is recorded on OpenGlass as attestation <code>${esc(v.attestationId)}</code>${
          record.status === "issued"
            ? ` (record <code>${esc(record.recordId)}</code>). <a href="${esc(v.bundleUrl)}">Download the record bundle</a>.`
            : ". The signed record is being issued; the bundle link works once it is."
        }</p><p>${esc(v.how)}</p>`
      : `<p>Not recorded on OpenGlass: ${esc(v.reason)}.</p>`;
  const witnessed = witnessLine(report);
  return layout(
    `Checkup: ${target}`,
    `<p class="label">Agent checkup · ${esc(report.checkedAt)}</p>
<h1 class="data">${esc(target)}</h1>
<div class="grid"><div class="panel"><p class="label">Overall</p><p class="score">${report.overall === null ? "n/a" : `${report.overall}/100`}</p></div></div>
<h2>Sections</h2>
${sections}
<h2>Top fixes</h2>
${fixes}
<h2>OpenGlass</h2>
${ogLine}
${witnessed ? `<p>${esc(witnessed)}</p>` : ""}
${verification}
<h2>Full report</h2>
<p><a href="${esc(report.links.json)}">JSON</a>. ${esc(report.note)}</p>
<pre>${esc(JSON.stringify(report, null, 2))}</pre>`,
  );
}

export interface AdminView {
  agent: { status: string; agentId: string | null; claimUrl: string | null; lastError: string | null; publicKey: string };
  windows: { label: string; metrics: Record<string, number> }[];
  registrationsFromClaims: number;
  claimedDomains: string[];
  recent: { id: string; targetKey: string; createdAt: Date; overall: number | null; recorded: boolean }[];
}

const METRIC_LABELS: Record<string, string> = {
  checksRun: "Checks run",
  registryProbes: "A2A Registry probes",
  cacheHits: "Served from cache",
  uniqueTargets: "Unique targets",
  reportOpens: "Report-link opens",
  claimClicks: "Claim-link clicks",
  unclaimedListed: "Unclaimed profiles listed",
};

export function adminPage(view: AdminView): string {
  const rows = Object.keys(METRIC_LABELS)
    .map((key) => `<tr><td>${METRIC_LABELS[key]}</td>${view.windows.map((w) => `<td>${w.metrics[key] ?? 0}</td>`).join("")}</tr>`)
    .join("");
  const a = view.agent;
  const agent =
    a.status === "active"
      ? `<p>Registered and claimed: <code>${esc(a.agentId)}</code>.</p>`
      : `<p>Status: <strong>${esc(a.status)}</strong>${a.agentId ? ` (<code>${esc(a.agentId)}</code>)` : ""}. Checkups are not recorded until the agent is claimed.</p>
${a.claimUrl ? `<p>Claim it while signed in to OpenGlass as its owner: <a href="${esc(a.claimUrl)}">${esc(a.claimUrl)}</a></p>` : ""}
${a.agentId ? `<form method="post" action="/admin/claim-link"><button type="submit">New claim link</button></form>` : ""}`;
  return layout(
    "Agent Checkup admin",
    `<p class="label">Admin</p><h1>Agent Checkup</h1>
<h2>OpenGlass agent</h2>${agent}
${a.lastError ? `<p>Last error: <code>${esc(a.lastError)}</code></p>` : ""}
<p>Public key: <code>${esc(a.publicKey)}</code></p>
<h2>Metrics</h2>
<div class="table-scroll"><table><thead><tr><th>Metric</th>${view.windows.map((w) => `<th>${esc(w.label)}</th>`).join("")}</tr></thead>
<tbody>${rows}<tr><td>Registrations from claims</td><td colspan="${view.windows.length}">${view.registrationsFromClaims}${
      view.claimedDomains.length ? ` (${view.claimedDomains.map(esc).join(", ")})` : ""
    }</td></tr></tbody></table></div>
<p>A2A Registry probes are told apart by user-agent (<code>A2A-Registry-*</code>). Registrations from claims counts domains whose claim link was clicked and whose OpenGlass profile has since been claimed.</p>
<h2>Recent checkups</h2>
<div class="table-scroll"><table><thead><tr><th>Report</th><th>Target</th><th>Score</th><th>Recorded</th><th>When</th></tr></thead><tbody>
${view.recent.map((r) => `<tr><td><a class="data" href="/r/${esc(r.id)}">${esc(r.id)}</a></td><td class="data">${esc(r.targetKey)}</td><td>${r.overall ?? "n/a"}</td><td>${r.recorded ? "yes" : "no"}</td><td>${esc(r.createdAt.toISOString())}</td></tr>`).join("")}
</tbody></table></div>`,
  );
}
