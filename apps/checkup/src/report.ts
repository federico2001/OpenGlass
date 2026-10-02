import type { CardDetails } from "./checks/card.js";
import type { EndpointDetails } from "./checks/endpoint.js";
import type { IdentityDetails } from "./checks/identity.js";
import type { Finding, Section, Severity } from "./checks/types.js";
import type { X402Details } from "./checks/x402.js";

export const SECTION_NAMES = ["card", "endpoint", "x402", "identity"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export interface Sections {
  card: Section<CardDetails>;
  endpoint: Section<EndpointDetails>;
  x402: Section<X402Details>;
  identity: Section<IdentityDetails>;
}

export type ProfileStatus = "registered" | "unclaimed" | "unavailable" | "not-applicable";

export interface OpenGlassProfile {
  status: ProfileStatus;
  agentId: string | null;
  domainVerified: boolean | null;
  /** Where the profile lives on OpenGlass. */
  profileUrl: string | null;
  /** For an unclaimed profile: this service's counted redirect to the claim page. */
  claimLink: string | null;
  /** The OpenGlass page the claim link redirects to. */
  claimUrl: string | null;
  line: string;
}

export interface Verification {
  status: "recorded" | "not-recorded";
  attestationId: string | null;
  bundleUrl: string | null;
  reason: string | null;
  how: string;
}

export interface Report {
  v: 1;
  type: "openglass.checkup.report";
  reportId: string;
  checkedAt: string;
  target: { key: string; origin: string; cardUrl: string | null; domain: string | null };
  overall: number | null;
  sections: Sections;
  topFixes: (Finding & { section: SectionName })[];
  openglass: OpenGlassProfile;
  links: { report: string; json: string };
  verification: Verification;
  note: string;
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const DATA_NOTE =
  "Everything the checked agent returned (its card and its replies) was treated as data. Nothing in it was followed, executed or used to choose what to do next.";

export const verifyHow = (openglassUrl: string) =>
  "Download the bundle and verify it offline with openglass-sdk: verifyBundle(bundle, keys), using the platform keys from " +
  `${openglassUrl}/.well-known/openglass-keys.json. Or POST it to ${openglassUrl}/v1/verify.`;

export function overallScore(sections: Sections): number | null {
  const scores = SECTION_NAMES.map((n) => sections[n].score).filter((s): s is number => s !== null);
  return scores.length === 0 ? null : Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

/** The three most important fixes across sections: by severity, then section order. */
export function topFixes(sections: Sections): Report["topFixes"] {
  const all = SECTION_NAMES.flatMap((section) => sections[section].findings.map((f) => ({ ...f, section })));
  const seen = new Set<string>();
  return all
    .map((f, i) => ({ f, i }))
    .sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i)
    .map(({ f }) => f)
    .filter((f) => (seen.has(f.fix) ? false : (seen.add(f.fix), true)))
    .slice(0, 3);
}

const LABELS: Record<SectionName, string> = { card: "Card", endpoint: "Endpoint", x402: "x402", identity: "Identity" };

/** The short plain-language report. */
export function renderText(report: Report, opts: { cached?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Agent Checkup: ${report.target.cardUrl ?? report.target.origin}`);
  lines.push(`Overall: ${report.overall === null ? "n/a" : `${report.overall}/100`}${opts.cached ? ` (cached result from ${report.checkedAt})` : ""}`);
  lines.push("");
  for (const name of SECTION_NAMES) {
    const s = report.sections[name];
    const score = s.score === null ? "n/a" : `${s.score}/100`;
    lines.push(`${LABELS[name].padEnd(9)}${score.padEnd(8)}${s.summary}`);
  }
  lines.push("");
  if (report.topFixes.length > 0) {
    lines.push("Top fixes:");
    report.topFixes.forEach((f, i) => lines.push(`${i + 1}. ${f.fix}`));
  } else {
    lines.push("Top fixes: nothing to fix.");
  }
  lines.push("");
  if (report.openglass.line) lines.push(report.openglass.line);
  lines.push(`Full report: ${report.links.report}`);
  if (report.verification.bundleUrl) lines.push(`Record of this checkup (verifiable offline): ${report.verification.bundleUrl}`);
  else lines.push(`Not recorded on OpenGlass: ${report.verification.reason ?? "unavailable"}.`);
  return lines.join("\n");
}
