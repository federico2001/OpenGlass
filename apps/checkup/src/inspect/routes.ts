import type { FastifyInstance, FastifyReply } from "fastify";
import type { NetPolicy } from "../net.js";
import { InspectError } from "./common.js";
import { inspectContent, type ContentReport } from "./content.js";
import { checkInspectUrl, decoderFor, fetchForInspection } from "./fetch.js";
import { FetchLimiter } from "./limiter.js";
import { inspectMcpConfig, type ConfigReport } from "./mcpConfig.js";
import { INSPECT_CSS, configFormPage, configReportPage, contentFormPage, contentReportPage, inspectIndexPage } from "./pages.js";

/**
 * Routes for the two inspection tools, as an encapsulated Fastify plugin so its body
 * parsing and error handling never touch the checkup's own routes:
 *
 *   GET  /inspect, /inspect/content, /inspect/mcp-config   forms
 *   POST /inspect/content, /inspect/mcp-config              HTML report in the response
 *   POST /api/inspect/content, /api/inspect/mcp-config      JSON report (the MCP tools use these)
 *
 * Privacy: bodies are parsed as plain strings and never logged (Fastify's request log has
 * method and path only, and this plugin's error handler logs an error code, never a message
 * that could quote input). Nothing is written to the database. Responses are no-store.
 */

export interface InspectRouteOptions {
  net: NetPolicy;
  limiter: FetchLimiter;
  /** Tests only (fake target on a random port). */
  allowAnyPort?: boolean;
}

const CONTENT_BODY_LIMIT = 8 * 1024 * 1024; // 2 MB of input, percent-encoded in a form, plus slack
const CONFIG_BODY_LIMIT = 4 * 1024 * 1024;
const CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

type Fields = Record<string, unknown>;

function parseForm(body: string): Fields {
  return Object.fromEntries(new URLSearchParams(body));
}

function parseJson(body: string): Fields {
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Fields;
  } catch {
    /* fall through */
  }
  // JSON.parse's own message quotes the body, so it is never passed on.
  throw new InspectError("bad_request", "The request body must be a JSON object.");
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export async function runContentInspection(fields: { html?: string; text?: string; url?: string }, opts: InspectRouteOptions): Promise<ContentReport> {
  const given = (["html", "text", "url"] as const).filter((k) => typeof fields[k] === "string" && fields[k]!.length > 0);
  if (given.length !== 1) throw new InspectError("bad_request", "Give exactly one of html, text or url.");
  const [which] = given;
  if (which === "url") {
    const url = checkInspectUrl(fields.url!, opts.allowAnyPort);
    const release = opts.limiter.acquire(url.hostname);
    try {
      const fetched = await fetchForInspection(url.toString(), { policy: opts.net, allowAnyPort: opts.allowAnyPort });
      const { decode } = decoderFor(fetched.charset);
      return inspectContent({ kind: fetched.kind, bytes: fetched.bytes, truncatedUpstream: fetched.truncated, decode, fetch: fetched.facts });
    } finally {
      release();
    }
  }
  return inspectContent({ kind: which!, bytes: Buffer.from(fields[which!]!, "utf8") });
}

export function runConfigInspection(config: unknown): ConfigReport {
  if (typeof config === "string") return inspectMcpConfig(config);
  if (config && typeof config === "object") return inspectMcpConfig(JSON.stringify(config));
  throw new InspectError("bad_request", 'Give the MCP config as "config": a JSON string or object.');
}

function privateHeaders(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow").header("referrer-policy", "no-referrer");
}

export async function inspectRoutes(app: FastifyInstance, opts: InspectRouteOptions): Promise<void> {
  app.removeAllContentTypeParsers();
  for (const type of ["application/json", "application/x-www-form-urlencoded", "text/plain"]) {
    app.addContentTypeParser(type, { parseAs: "string" }, (_req, body, done) => done(null, body));
  }

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; retryAfter?: number }, req, reply) => {
    privateHeaders(reply);
    const isApi = req.url.startsWith("/api/");
    const inspect = err instanceof InspectError ? err : null;
    const status = inspect?.status ?? (err.statusCode === 413 ? 413 : err.statusCode === 415 ? 415 : 500);
    const code = inspect?.code ?? (status === 413 ? "too_large" : status === 415 ? "unsupported_media_type" : "error");
    const message =
      inspect?.message ??
      (status === 413 ? "The request is too large." : status === 415 ? "Send JSON (or a form post from the page)." : "Something went wrong. Please try again.");
    // Log the code only: an error message could quote the input.
    if (status >= 500 && !inspect) req.log.error({ code: err.code ?? "unknown", statusCode: status }, "inspection failed");
    if (err.retryAfter) reply.header("retry-after", String(err.retryAfter));
    if (isApi) return reply.code(status).send({ error: code, message });
    const form = req.url.startsWith("/inspect/mcp-config") ? configFormPage(message) : contentFormPage(message);
    return reply.code(status).type("text/html").header("content-security-policy", CSP).send(form);
  });

  const html = (reply: FastifyReply, body: string) => privateHeaders(reply).type("text/html").header("content-security-policy", CSP).send(body);

  app.get("/assets/inspect.css", async (_req, reply) => reply.type("text/css").header("cache-control", "public, max-age=3600").send(INSPECT_CSS));
  app.get("/inspect", async (_req, reply) => html(reply, inspectIndexPage()));
  app.get("/inspect/content", async (_req, reply) => html(reply, contentFormPage()));
  app.get("/inspect/mcp-config", async (_req, reply) => html(reply, configFormPage()));

  app.post("/inspect/content", { bodyLimit: CONTENT_BODY_LIMIT }, async (req, reply) => {
    const f = parseForm(String(req.body ?? ""));
    const mode = str(f.mode) ?? "html";
    const content = str(f.content) ?? "";
    const fields = mode === "url" ? { url: str(f.url) ?? "" } : mode === "text" ? { text: content } : { html: content };
    return html(reply, contentReportPage(await runContentInspection(fields, opts)));
  });

  app.post("/inspect/mcp-config", { bodyLimit: CONFIG_BODY_LIMIT }, async (req, reply) => {
    const f = parseForm(String(req.body ?? ""));
    return html(reply, configReportPage(runConfigInspection(str(f.config) ?? "")));
  });

  app.post("/api/inspect/content", { bodyLimit: CONTENT_BODY_LIMIT }, async (req, reply) => {
    const f = parseJson(String(req.body ?? ""));
    return privateHeaders(reply).send(await runContentInspection({ html: str(f.html), text: str(f.text), url: str(f.url) }, opts));
  });

  app.post("/api/inspect/mcp-config", { bodyLimit: CONFIG_BODY_LIMIT }, async (req, reply) => {
    const f = parseJson(String(req.body ?? ""));
    return privateHeaders(reply).send(runConfigInspection(f.config));
  });
}

export { FetchLimiter };
