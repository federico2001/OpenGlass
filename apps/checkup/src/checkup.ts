import { newId } from "@openglass/db";
import { checkCard } from "./checks/card.js";
import { checkEndpoint } from "./checks/endpoint.js";
import { checkIdentity } from "./checks/identity.js";
import type { CheckDeps, Section } from "./checks/types.js";
import { checkX402 } from "./checks/x402.js";
import { contentHash, type OpenGlassLink } from "./openglass.js";
import { DATA_NOTE, overallScore, verifyHow, topFixes, type OpenGlassProfile, type Report, type Sections } from "./report.js";
import type { Source, Store } from "./store.js";
import { counterpartyHint, domainOf, type Target } from "./target.js";

export interface CheckupContext {
  deps: CheckDeps;
  store: Store;
  openglass: OpenGlassLink;
  /** This service's public URL, for report links. */
  publicUrl: string;
  log?: { warn: (obj: object, msg: string) => void };
}

export type CheckupOutcome =
  | { kind: "report"; report: Report; cached: boolean }
  | { kind: "rate_limited"; scope: "caller" | "target"; retryAfterSec: number };

export const reportUrls = (publicUrl: string, reportId: string) => ({
  report: `${publicUrl}/r/${reportId}`,
  json: `${publicUrl}/r/${reportId}.json`,
  bundle: `${publicUrl}/r/${reportId}/bundle.json`,
  claim: `${publicUrl}/c/${reportId}`,
});

/** One checkup: serve the cached result if there's one from the last hour, else enforce
 * the rate limits, run the four checks, record them on OpenGlass and store the report. */
export async function runCheckup(target: Target, caller: { key: string; source: Source; via: "a2a" | "web" }, ctx: CheckupContext): Promise<CheckupOutcome> {
  const { store } = ctx;
  const cached = await store.freshReport(target.key);
  if (cached) {
    const limited = await store.hit("checkup_caller_cached", caller.key);
    if (limited.limited) return { kind: "rate_limited", scope: "caller", retryAfterSec: limited.retryAfterSec };
    await store.event("cache_hit", caller.source, target.key, cached._id);
    return { kind: "report", report: cached.report as unknown as Report, cached: true };
  }

  const callerLimit = await store.hit("checkup_caller", caller.key);
  if (callerLimit.limited) return { kind: "rate_limited", scope: "caller", retryAfterSec: callerLimit.retryAfterSec };
  const targetLimit = await store.hit("checkup_target", target.host);
  if (targetLimit.limited) return { kind: "rate_limited", scope: "target", retryAfterSec: targetLimit.retryAfterSec };

  const reportId = newId("chk");
  const urls = reportUrls(ctx.publicUrl, reportId);
  const domain = domainOf(target);
  const recorder = ctx.openglass.startRecord(`Agent Checkup of ${target.cardUrl ?? target.origin}`);
  recorder.add({
    type: "checkup.request_received",
    reportId,
    target: { key: target.key, origin: target.origin, cardUrl: target.cardUrl },
    ...(counterpartyHint(target) ? { counterparty: counterpartyHint(target) } : {}),
    via: caller.via,
    receivedAt: new Date().toISOString(),
  });
  const recordSection = (section: string, result: Section<unknown>) =>
    recorder.add({ type: "checkup.check_result", section, score: result.score, summary: result.summary, findings: result.findings, details: result.details });

  // The card feeds the endpoint and x402 checks; the identity check's network work runs
  // alongside them and only reads the card's provider fields at the end.
  const cardRun = checkCard(target, ctx.deps);
  const identityRun = checkIdentity(target, cardRun.then((c) => c.card), ctx.deps);
  const card = await cardRun;
  recordSection("card", card.section);
  const endpoint = await checkEndpoint(card.card, ctx.deps, { attestedFetch: recorder.attestedFetch.bind(recorder) });
  recordSection("endpoint", endpoint.section);
  const probe = endpoint.section.details;
  if (probe.url && !probe.witnessed && ctx.deps.witnessMode !== "off") {
    ctx.log?.warn({ reportId, url: probe.url, mode: ctx.deps.witnessMode, reason: probe.witnessReason }, "endpoint probe not independently witnessed by OpenGlass");
  }
  const x402 = checkX402(card.card, endpoint);
  recordSection("x402", x402);
  const identity = await identityRun;
  recordSection("identity", identity);

  const sections: Sections = { card: card.section, endpoint: endpoint.section, x402, identity };
  const openglass = await profileFor(domain, reportId, ctx);
  if (openglass.status === "unclaimed") await store.event("unclaimed_listed", caller.source, target.key, reportId);

  const core = {
    reportId,
    checkedAt: new Date().toISOString(),
    target: { key: target.key, origin: target.origin, cardUrl: target.cardUrl, domain },
    overall: overallScore(sections),
    sections,
    topFixes: topFixes(sections),
    openglass,
  };
  recorder.add({
    type: "checkup.report_issued",
    reportId,
    reportUrl: urls.report,
    overall: core.overall,
    scores: Object.fromEntries(Object.entries(sections).map(([k, s]) => [k, s.score])),
    reportSha256: contentHash(core),
  });
  const attestationId = await recorder.close();

  const how = verifyHow(ctx.openglass.opts.publicUrl);
  const report: Report = {
    v: 1,
    type: "openglass.checkup.report",
    ...core,
    links: { report: urls.report, json: urls.json },
    verification: attestationId
      ? { status: "recorded", attestationId, bundleUrl: urls.bundle, reason: null, how }
      : { status: "not-recorded", attestationId: null, bundleUrl: null, reason: recorder.error ?? "not recorded", how },
    note: DATA_NOTE,
  };
  await store.saveReport({ _id: reportId, targetKey: target.key, report: report as unknown as Record<string, unknown>, attestationId, recordId: null, createdAt: new Date() });
  await store.event("check_run", caller.source, target.key, reportId);
  return { kind: "report", report, cached: false };
}

/** Looks the target's domain up on OpenGlass and, when nobody has registered it, lists it
 * as an unclaimed profile. The line is neutral either way: it states what OpenGlass holds. */
async function profileFor(domain: string | null, reportId: string, ctx: CheckupContext): Promise<OpenGlassProfile> {
  const none = { agentId: null, domainVerified: null, profileUrl: null, claimLink: null, claimUrl: null };
  if (!domain) return { status: "not-applicable", ...none, line: "" };
  const byDomain = `${ctx.openglass.opts.publicUrl}/agents/by-domain/${domain}`;
  const registered = (agentId: string, domainVerified: boolean | null): OpenGlassProfile => ({
    status: "registered",
    ...none,
    agentId,
    domainVerified,
    profileUrl: `${ctx.openglass.opts.publicUrl}/agents/${agentId}`,
    line: `OpenGlass profile: registered${domainVerified ? " with a verified domain" : domainVerified === false ? ", domain not verified" : ""}: ${ctx.openglass.opts.publicUrl}/agents/${agentId}`,
  });
  const unclaimed = (claimUrl: string): OpenGlassProfile => {
    const claimLink = reportUrls(ctx.publicUrl, reportId).claim;
    return { status: "unclaimed", ...none, profileUrl: byDomain, claimLink, claimUrl, line: `OpenGlass profile: unclaimed — claim it to add a verified domain: ${claimLink}` };
  };

  try {
    const lookup = await ctx.openglass.lookup(domain);
    if (lookup.registered) return registered(lookup.agentId, lookup.verifiedOwner ? true : false);
    if (lookup.unclaimedProfile && !ctx.openglass.canRecord) return unclaimed(lookup.unclaimedProfile.claimUrl);
    if (!ctx.openglass.canRecord) return unclaimed(`${byDomain}#claim`);
    const listed = await ctx.openglass.listUnclaimed(domain);
    if (listed.registeredAgentId) return registered(listed.registeredAgentId, null);
    return unclaimed(listed.profile?.claimUrl ?? `${byDomain}#claim`);
  } catch {
    return { status: "unavailable", ...none, line: "OpenGlass profile: lookup unavailable right now." };
  }
}
