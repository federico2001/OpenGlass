import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import type { WitnessMode } from "openglass-sdk";
import { ownAgentCard } from "./a2a.js";
import { runCheckup, type CheckupContext } from "./checkup.js";
import type { OpenGlassLink } from "./openglass.js";
import { SITE_CSS, adminPage, landingPage, messagePage, reportPage } from "./pages.js";
import type { Report } from "./report.js";
import { handleRpc, rpcError } from "./rpc.js";
import { createStore, type Source } from "./store.js";
import { parseTarget } from "./target.js";

export interface ServerOptions {
  db: Db;
  openglass: OpenGlassLink;
  publicUrl: string;
  adminToken: string;
  registryUrl: string;
  allowPrivateTargets: boolean;
  /** docs/SPEC.md §12.7. Defaults to "shadow" — see config.ts's CHECKUP_WITNESS_MODE for why
   * that, not sdk-js's own "primary" recommendation, is this service's own default. */
  witnessMode?: WitnessMode;
  logger?: boolean | { level: string };
}

const USER_AGENT = "OpenGlass-AgentCheckup/1.0 (+https://checkup.openglass.glass)";
const MAX_RPC_BODY = 64 * 1024;

/** A2A Registry probes identify themselves by user-agent (A2A-Registry-TaskProbe/1.0,
 * A2A-Registry-Smoke/1.0); everything else counts as a user. */
export function sourceOf(req: FastifyRequest): Source {
  return /^A2A-Registry-/i.test(req.headers["user-agent"] ?? "") ? "registry" : "user";
}

const require = createRequire(import.meta.url);
const FONTS: Record<string, string> = Object.fromEntries(
  [
    ["manrope", "manrope-latin-400-normal.woff2"],
    ["manrope", "manrope-latin-600-normal.woff2"],
    ["manrope", "manrope-latin-800-normal.woff2"],
    ["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2"],
    ["ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff2"],
    ["fragment-mono", "fragment-mono-latin-400-normal.woff2"],
  ].map(([pkg, file]) => [file!, require.resolve(`@fontsource/${pkg}/files/${file}`)]),
);

/** apps/web's tokens.css: copied next to dist/ at build time, read from the web app in dev. */
function loadTokens(): string {
  for (const candidate of ["./assets/tokens.css", "../../web/app/tokens.css"]) {
    try {
      return readFileSync(new URL(candidate, import.meta.url), "utf8");
    } catch {
      /* try the next one */
    }
  }
  throw new Error("tokens.css not found");
}

export function buildServer(opts: ServerOptions) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: MAX_RPC_BODY });
  const store = createStore(opts.db);
  const ctx: CheckupContext = {
    store,
    openglass: opts.openglass,
    publicUrl: opts.publicUrl,
    deps: { net: { allowPrivateAddresses: opts.allowPrivateTargets, userAgent: USER_AGENT }, registryUrl: opts.registryUrl, witnessMode: opts.witnessMode ?? "shadow" },
  };
  // A2A 1.0 clients may label JSON-RPC bodies with the A2A media type.
  app.addContentTypeParser("application/a2a+json", { parseAs: "string" }, app.getDefaultJsonParser("error", "error"));
  const tokensCss = loadTokens();
  const card = ownAgentCard(opts.publicUrl, opts.openglass.opts.publicUrl);

  // A malformed JSON-RPC body still deserves a JSON-RPC error, not Fastify's default 400.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (req.method === "POST" && (req.url === "/a2a" || req.url === "/")) {
      const status = err.statusCode === 413 ? 413 : 200;
      return reply.code(status).send(rpcError(null, err.statusCode === 413 ? -32600 : -32700, err.statusCode === 413 ? "Request too large" : "Parse error"));
    }
    req.log.error({ err }, "request failed");
    return reply.code(err.statusCode ?? 500).type("text/html").send(messagePage("Something went wrong", "Please try again in a minute.", String(err.statusCode ?? 500)));
  });

  app.get("/health", async () => {
    await opts.db.command({ ping: 1 });
    return { ok: true, openglassAgent: opts.openglass.status };
  });

  for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
    app.get(path, async (_req, reply) => reply.header("access-control-allow-origin", "*").header("cache-control", "public, max-age=300").send(card));
  }

  for (const path of ["/a2a", "/"]) {
    app.post(path, async (req, reply) => {
      const result = await handleRpc(req.body, { key: req.ip, source: sourceOf(req) }, ctx);
      return reply.header("content-type", "application/json").send(result);
    });
  }

  app.get("/", async (_req, reply) => reply.type("text/html").send(landingPage(opts.publicUrl)));

  app.get<{ Querystring: { target?: string } }>("/check", async (req, reply) => {
    const target = parseTarget(req.query.target ?? "");
    if (!target) {
      return reply.code(400).type("text/html").send(messagePage("That isn't a URL or a domain", "Enter an agent-card URL or a domain, like example.com.", "400"));
    }
    const outcome = await runCheckup(target, { key: req.ip, source: sourceOf(req), via: "web" }, ctx);
    if (outcome.kind === "rate_limited") {
      reply.header("retry-after", String(outcome.retryAfterSec));
      const who = outcome.scope === "caller" ? "You've run" : "This target has had";
      return reply.code(429).type("text/html").send(messagePage("Too many checkups", `${who} too many checkups in the last hour. Try again later.`, "429"));
    }
    return reply.redirect(`/r/${outcome.report.reportId}`, 303);
  });

  app.get<{ Params: { id: string } }>("/r/:id", async (req, reply) => {
    const asJson = req.params.id.endsWith(".json");
    const id = asJson ? req.params.id.slice(0, -5) : req.params.id;
    const doc = await store.getReport(id);
    if (!doc) return notFound(reply, asJson);
    await store.event("report_open", sourceOf(req), doc.targetKey, doc._id);
    const report = doc.report as unknown as Report;
    if (asJson) return reply.header("access-control-allow-origin", "*").send(report);
    let recordId = doc.recordId;
    if (doc.attestationId && !recordId && opts.openglass.canRecord) {
      recordId = await opts.openglass.recordIdFor(doc.attestationId).catch(() => null);
      if (recordId) await store.setRecordId(doc._id, recordId);
    }
    const status = !doc.attestationId ? "none" : recordId ? "issued" : "pending";
    return reply.type("text/html").send(reportPage(report, { status, recordId }));
  });

  /** The checkup's own record bundle, fetched from OpenGlass with the checkup agent's key.
   * OpenGlass never makes a record public; this agent publishes its own. */
  app.get<{ Params: { id: string } }>("/r/:id/bundle.json", async (req, reply) => {
    const limit = await store.hit("checkup_bundle", req.ip);
    if (limit.limited) return reply.code(429).header("retry-after", String(limit.retryAfterSec)).send({ error: "rate_limited" });
    const doc = await store.getReport(req.params.id);
    if (!doc?.attestationId) return reply.code(404).send({ error: "not_found", message: "No OpenGlass record for this report" });
    let recordId = doc.recordId;
    if (!recordId) {
      recordId = await opts.openglass.recordIdFor(doc.attestationId).catch(() => null);
      if (!recordId) return reply.code(202).header("retry-after", "10").send({ status: "pending", message: "The record is being issued; try again shortly." });
      await store.setRecordId(doc._id, recordId);
    }
    const bundle = await opts.openglass.bundle(recordId);
    return reply.header("access-control-allow-origin", "*").header("cache-control", "public, max-age=3600").send(bundle);
  });

  /** Counted redirect to the target's OpenGlass claim page. */
  app.get<{ Params: { id: string } }>("/c/:id", async (req, reply) => {
    const doc = await store.getReport(req.params.id);
    const claimUrl = (doc?.report as unknown as Report | undefined)?.openglass?.claimUrl;
    if (!doc || !claimUrl) return notFound(reply, false);
    await store.event("claim_click", sourceOf(req), doc.targetKey, doc._id);
    return reply.redirect(claimUrl, 302);
  });

  // ---------------------------------------------------------------- admin
  const isAdmin = (req: FastifyRequest) => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Basic ")) return false;
    const password = Buffer.from(header.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
    const a = Buffer.from(password);
    const b = Buffer.from(opts.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const challenge = (reply: FastifyReply) => reply.code(401).header("www-authenticate", 'Basic realm="Agent Checkup admin"').send("Authentication required");

  app.get("/admin", async (req, reply) => {
    if (!isAdmin(req)) return challenge(reply);
    await opts.openglass.refreshStatus();
    const now = Date.now();
    const windows = await Promise.all(
      [
        ["24 hours", 86_400_000],
        ["7 days", 7 * 86_400_000],
        ["30 days", 30 * 86_400_000],
        ["All time", now],
      ].map(async ([label, ms]) => ({ label: label as string, metrics: await store.metrics(new Date(now - (ms as number))) })),
    );
    const claimed = await registrationsFromClaims(ctx);
    const link = opts.openglass;
    return reply.type("text/html").send(
      adminPage({
        agent: { status: link.status, agentId: link.agentId, claimUrl: link.claimUrl, lastError: link.lastError, publicKey: link.publicKey },
        windows,
        registrationsFromClaims: claimed.length,
        claimedDomains: claimed,
        recent: await store.recentReports(25),
      }),
    );
  });

  app.post("/admin/claim-link", async (req, reply) => {
    if (!isAdmin(req)) return challenge(reply);
    await opts.openglass.newClaimLink();
    return reply.redirect("/admin", 303);
  });

  // ---------------------------------------------------------------- assets
  app.get("/assets/tokens.css", async (_req, reply) => reply.type("text/css").header("cache-control", "public, max-age=3600").send(tokensCss));
  app.get("/assets/site.css", async (_req, reply) => reply.type("text/css").header("cache-control", "public, max-age=3600").send(SITE_CSS));
  app.get<{ Params: { file: string } }>("/assets/fonts/:file", async (req, reply) => {
    const path = FONTS[req.params.file];
    if (!path) return reply.code(404).send();
    return reply.type("font/woff2").header("cache-control", "public, max-age=31536000, immutable").send(readFileSync(path));
  });

  return app;
}

function notFound(reply: FastifyReply, json: boolean) {
  if (json) return reply.code(404).send({ error: "not_found" });
  return reply.code(404).type("text/html").send(messagePage("Report not found", "This report doesn't exist or has expired.", "404"));
}

/** Domains whose claim link was clicked and whose OpenGlass profile has since been claimed. */
async function registrationsFromClaims(ctx: CheckupContext): Promise<string[]> {
  const ids = await ctx.store.clickedClaimReportIds(100);
  const docs = await ctx.store.reportsByIds(ids);
  const domains = [...new Set(docs.map((d) => (d.report as unknown as Report).target?.domain).filter((d): d is string => !!d))];
  const results = await Promise.all(
    domains.map((domain) =>
      ctx.openglass.getUnclaimed(domain).then(
        (p) => (p?.claimed ? domain : null),
        () => null,
      ),
    ),
  );
  return results.filter((d): d is string => d !== null);
}
