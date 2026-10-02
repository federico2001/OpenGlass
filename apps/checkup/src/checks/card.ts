import { createHash } from "node:crypto";
import type { z } from "zod";
import { A2A_CURRENT, AgentCardV03, AgentCardV1, cardShape, type CardShape } from "../a2a.js";
import { NetError, safeFetch } from "../net.js";
import type { Target } from "../target.js";
import { clamp, quoteData, type CheckDeps, type Finding, type Section } from "./types.js";

export const MAX_CARD_BYTES = 128 * 1024;
const WELL_KNOWN = ["/.well-known/agent-card.json", "/.well-known/agent.json"] as const;

export interface CardFetch {
  url: string;
  httpStatus: number | null;
  ok: boolean;
  contentType: string | null;
  bytes: number | null;
  error: string | null;
}

export interface Issue {
  path: string;
  message: string;
}

export interface CardDetails {
  fetched: CardFetch[];
  cardUrl: string | null;
  cardSha256: string | null;
  name: string | null;
  shape: CardShape | null;
  schemaErrors: Issue[];
  weakFields: Issue[];
}

export interface CardResult {
  section: Section<CardDetails>;
  /** The parsed card, for the other checks. Never echoed into the report. */
  card: Record<string, unknown> | null;
}

export async function checkCard(target: Target, deps: CheckDeps): Promise<CardResult> {
  const urls = target.cardUrl ? [target.cardUrl] : WELL_KNOWN.map((p) => `${target.origin}${p}`);
  const fetched: CardFetch[] = [];
  let card: Record<string, unknown> | null = null;
  let cardUrl: string | null = null;
  let cardSha256: string | null = null;
  let notJson = false;

  // Both well-known paths are fetched (in parallel) even when the first has a card, so the
  // report can say which ones exist; the first one that parses is the card that's checked.
  const responses = await Promise.all(
    urls.map((url) =>
      safeFetch(url, { maxBytes: MAX_CARD_BYTES, followRedirects: true, headers: { accept: "application/json" } }, deps.net).then(
        (res) => ({ url, res, err: null }),
        (err: unknown) => ({ url, res: null, err }),
      ),
    ),
  );
  for (const { url, res, err } of responses) {
    if (!res) {
      fetched.push({ url, httpStatus: null, ok: false, contentType: null, bytes: null, error: err instanceof NetError ? err.message : "request failed" });
      continue;
    }
    const entry: CardFetch = {
      url,
      httpStatus: res.status,
      ok: res.status === 200,
      contentType: res.headers.get("content-type"),
      bytes: res.body.byteLength,
      error: res.status === 200 ? null : `HTTP ${res.status}`,
    };
    if (res.status === 200) {
      try {
        const parsed: unknown = JSON.parse(res.body.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          if (!card) {
            card = parsed as Record<string, unknown>;
            cardUrl = url;
            cardSha256 = createHash("sha256").update(res.body).digest("hex");
          }
        } else {
          entry.ok = false;
          entry.error = "not a JSON object";
          notJson = true;
        }
      } catch {
        entry.ok = false;
        entry.error = "not valid JSON";
        notJson = true;
      }
    }
    fetched.push(entry);
  }

  if (!card) {
    const blocked = fetched.some((f) => f.error?.includes("non-public"));
    return {
      card: null,
      section: {
        score: 0,
        summary: blocked ? "The target resolves to a private or reserved address, so nothing was fetched." : "No agent card was found.",
        findings: [
          {
            severity: "high",
            fix: notJson
              ? "Serve the agent card as a JSON object."
              : `Publish an agent card at ${target.origin}/.well-known/agent-card.json (the A2A ${A2A_CURRENT} path).`,
          },
        ],
        details: { fetched, cardUrl: null, cardSha256: null, name: null, shape: null, schemaErrors: [], weakFields: [] },
      },
    };
  }

  const shape = cardShape(card);
  const schema = shape === "1.0" ? AgentCardV1 : AgentCardV03;
  const parsed = schema.safeParse(card);
  const schemaErrors = parsed.success ? [] : issuesOf(parsed.error);
  const weakFields = weakFieldsOf(card);
  const findings: Finding[] = [];
  let score = 100;

  if (schemaErrors.length > 0) {
    score -= Math.min(60, 12 * schemaErrors.length);
    const first = schemaErrors[0]!;
    findings.push({
      severity: "high",
      fix: `Fix the card so it validates against the A2A ${shape} schema: ${first.path || "card"} ${first.message}${schemaErrors.length > 1 ? ` (and ${schemaErrors.length - 1} more)` : ""}.`,
    });
  }
  if (shape === "0.3") {
    score -= 10;
    findings.push({ severity: "medium", fix: `Add supportedInterfaces (url, protocolBinding, protocolVersion) so A2A ${A2A_CURRENT} clients can use the card.` });
  }
  if (!target.cardUrl) {
    const current = fetched.find((f) => f.url.endsWith("/agent-card.json"));
    if (current && !current.ok) {
      score -= 10;
      findings.push({ severity: "medium", fix: "Serve the card at /.well-known/agent-card.json, the path current A2A clients fetch; /.well-known/agent.json is the old one." });
    }
  }
  const contentType = fetched.find((f) => f.url === cardUrl)?.contentType ?? "";
  if (!/json/i.test(contentType)) {
    score -= 5;
    findings.push({ severity: "low", fix: "Serve the agent card with Content-Type: application/json." });
  }
  for (const weak of weakFields) {
    score -= weak.path.startsWith("skills") ? 4 : 6;
  }
  const weakFix = weakFixOf(weakFields);
  if (weakFix) findings.push(weakFix);

  const name = typeof card.name === "string" ? quoteData(card.name) : null;
  const summary =
    `${name ? `"${name}", ` : ""}A2A ${shape} card at ${cardUrl}` +
    (schemaErrors.length ? `; ${schemaErrors.length} schema error${schemaErrors.length === 1 ? "" : "s"}` : "; valid") +
    (weakFields.length ? `; ${weakFields.length} weak field${weakFields.length === 1 ? "" : "s"}.` : ".");

  return {
    card,
    section: { score: clamp(score), summary, findings, details: { fetched, cardUrl, cardSha256, name, shape, schemaErrors, weakFields } },
  };
}

function issuesOf(error: z.ZodError): Issue[] {
  return error.issues.slice(0, 20).map((i) => ({
    path: i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, ""),
    message: i.code === "invalid_type" && i.input === undefined ? "is required" : i.message.toLowerCase(),
  }));
}

/** Present-but-unhelpful fields: what makes a card hard for another agent (or its owner)
 * to decide whether and how to use this agent. */
function weakFieldsOf(card: Record<string, unknown>): Issue[] {
  const weak: Issue[] = [];
  const description = typeof card.description === "string" ? card.description.trim() : "";
  if (description && description.length < 40) weak.push({ path: "description", message: "is too short to say what the agent does (under 40 characters)" });
  const provider = card.provider as { organization?: unknown; url?: unknown } | undefined;
  if (!provider) weak.push({ path: "provider", message: "is missing (who runs this agent)" });
  if (!card.documentationUrl) weak.push({ path: "documentationUrl", message: "is missing" });
  const skills = Array.isArray(card.skills) ? (card.skills as Record<string, unknown>[]) : [];
  if (skills.length === 0) weak.push({ path: "skills", message: "is empty, so clients can't tell what the agent does" });
  skills.slice(0, 50).forEach((skill, i) => {
    const desc = typeof skill?.description === "string" ? skill.description.trim() : "";
    if (desc && desc.length < 20) weak.push({ path: `skills[${i}].description`, message: "is too short (under 20 characters)" });
    if (!Array.isArray(skill?.examples) || skill.examples.length === 0) weak.push({ path: `skills[${i}].examples`, message: "is missing; add one or two example requests" });
    if (!Array.isArray(skill?.tags) || skill.tags.length === 0) weak.push({ path: `skills[${i}].tags`, message: "is empty" });
  });
  return weak;
}

function weakFixOf(weak: Issue[]): Finding | null {
  if (weak.length === 0) return null;
  const missingExamples = weak.filter((w) => w.path.endsWith(".examples")).length;
  if (weak.some((w) => w.path === "skills")) return { severity: "high", fix: "List at least one skill on the card, with a description and examples." };
  if (weak.some((w) => w.path === "description")) return { severity: "medium", fix: "Write a card description that says what the agent does and for whom." };
  if (missingExamples > 0) return { severity: "medium", fix: `Add examples to ${missingExamples === 1 ? "the skill that has none" : `the ${missingExamples} skills that have none`}.` };
  if (weak.some((w) => w.path === "provider")) return { severity: "low", fix: "Add provider.organization and provider.url to the card." };
  return { severity: "low", fix: `Fill in ${weak[0]!.path} on the card.` };
}
