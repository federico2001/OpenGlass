import { randomUUID } from "node:crypto";
import { runCheckup, type CheckupContext } from "./checkup.js";
import { renderText } from "./report.js";
import type { Source } from "./store.js";
import { fromDomain, fromUrl, parseTarget, type Target } from "./target.js";

/**
 * The A2A JSON-RPC endpoint. One skill, one method family: `message/send` (A2A 0.3 wire
 * format) and `SendMessage` (A2A 1.0). Text in; text plus the JSON report out, as a direct
 * Message (no task: a checkup finishes within the request).
 */

type Wire = "0.3" | "1.0";

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const HELP =
  "Send me an agent-card URL (https://example.com/.well-known/agent-card.json) or a domain (example.com) " +
  "and I'll check the card, the endpoint, x402 and public identity signals, and reply with a report.";

export const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleRpc(body: unknown, caller: { key: string; source: Source }, ctx: CheckupContext): Promise<unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, -32600, "Invalid Request");
  const req = body as RpcRequest;
  const id = typeof req.id === "string" || typeof req.id === "number" ? req.id : null;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return rpcError(id, -32600, "Invalid Request");

  switch (req.method) {
    case "message/send":
      return sendMessage(id, req.params, "0.3", caller, ctx);
    case "SendMessage":
      return sendMessage(id, req.params, "1.0", caller, ctx);
    case "tasks/get":
    case "GetTask":
    case "tasks/cancel":
    case "CancelTask":
      return rpcError(id, -32001, "Task not found: this agent answers with messages and never creates tasks");
    case "message/stream":
    case "SendStreamingMessage":
    case "tasks/resubscribe":
    case "SubscribeToTask":
      return rpcError(id, -32004, "Streaming is not supported");
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

async function sendMessage(id: unknown, params: unknown, wire: Wire, caller: { key: string; source: Source }, ctx: CheckupContext) {
  const message = (params as { message?: unknown } | null)?.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object" || !Array.isArray(message.parts)) {
    return rpcError(id, -32602, "Invalid params: params.message.parts is required");
  }
  const contextId = typeof message.contextId === "string" && message.contextId.length <= 200 ? message.contextId : randomUUID();
  const target = targetFrom(message.parts as unknown[]);

  if (caller.source === "registry") await ctx.store.event("check_run", "registry", target?.key ?? null, null);
  if (!target) return reply(id, wire, contextId, HELP, null);

  const outcome = await runCheckup(target, { ...caller, via: "a2a" }, ctx);
  if (outcome.kind === "rate_limited") {
    const minutes = Math.ceil(outcome.retryAfterSec / 60);
    const who = outcome.scope === "caller" ? "You've run" : "This target has had";
    return reply(id, wire, contextId, `${who} too many checkups in the last hour. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`, null);
  }
  return reply(id, wire, contextId, renderText(outcome.report, { cached: outcome.cached }), { ...outcome.report, cached: outcome.cached });
}

/** The target comes from a data part (`target`, `agentCardUrl` or `domain`) or else the
 * text. Only a URL or hostname is ever extracted; the rest of the message is ignored. */
export function targetFrom(parts: unknown[]): Target | null {
  const texts: string[] = [];
  for (const part of parts.slice(0, 20)) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const data = (p.kind === "data" ? p.data : (p.data ?? null)) as Record<string, unknown> | null;
    if (data && typeof data === "object") {
      for (const key of ["agentCardUrl", "target", "domain", "url"]) {
        const value = data[key];
        if (typeof value === "string") {
          const t = /^https?:\/\//i.test(value) ? fromUrl(value.trim()) : fromDomain(value.trim());
          if (t) return t;
        }
      }
    }
    if (typeof p.text === "string") texts.push(p.text);
  }
  return texts.length ? parseTarget(texts.join("\n")) : null;
}

function reply(id: unknown, wire: Wire, contextId: string, text: string, data: Record<string, unknown> | null) {
  const messageId = randomUUID();
  if (wire === "0.3") {
    const parts: unknown[] = [{ kind: "text", text }];
    if (data) parts.push({ kind: "data", data });
    return { jsonrpc: "2.0", id, result: { kind: "message", messageId, contextId, role: "agent", parts } };
  }
  const parts: unknown[] = [{ text, mediaType: "text/plain" }];
  if (data) parts.push({ data, mediaType: "application/json" });
  return { jsonrpc: "2.0", id, result: { message: { messageId, contextId, role: "ROLE_AGENT", parts } } };
}
