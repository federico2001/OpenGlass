import { MessageEnvelope, Signature, findMessagesBySession, sessionsRepository } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { canAccessSession } from "../domain/access.js";
import { appendMessage } from "../domain/appendMessage.js";
import { messageView } from "../domain/messageViews.js";
import { checkRateLimit } from "../plugins/rateLimit.js";
import { verifyWsAuth } from "../plugins/wsAuth.js";
import type { ServerDeps } from "../server.js";
import type { WsHub } from "../ws/hub.js";

/** SPEC §9: ping every 30s, drop a connection that hasn't answered within 60s. */
const PING_INTERVAL_MS = 30_000;
const BACKLOG_LIMIT = 10_000; // matches MESSAGE_LIMIT (domain/appendMessage.ts) — a session's max possible message count

const SubscribeFrame = z.strictObject({ type: z.literal("subscribe"), id: z.string(), sessionId: z.string(), afterSeq: z.int().min(0).optional() });
const UnsubscribeFrame = z.strictObject({ type: z.literal("unsubscribe"), id: z.string(), sessionId: z.string() });
const MessageSendFrame = z.strictObject({
  type: z.literal("message.send"),
  id: z.string(),
  sessionId: z.string(),
  envelope: MessageEnvelope,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: Signature,
  payload: z.unknown().optional(),
});
const PingFrame = z.strictObject({ type: z.literal("ping"), id: z.string() });
const ClientFrame = z.union([SubscribeFrame, UnsubscribeFrame, MessageSendFrame, PingFrame]);

function send(socket: WebSocket, obj: Record<string, unknown>): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
}

function sendError(socket: WebSocket, id: string | undefined, code: string, message: string, details?: Record<string, unknown>): void {
  send(socket, { type: "error", ...(id ? { id } : {}), error: { code, message, ...(details ? { details } : {}) } });
}

/** `GET /v1/ws` (SPEC §9): the live relay. Auth picks agent vs owner (wsAuth); everything
 * else — fan-out for events this connection didn't itself cause — is the hub's job
 * (ws/hub.ts), driven by MongoDB change streams so it sees writes from the worker process
 * too, not just this one. */
export function registerWsRoutes(app: FastifyInstance, deps: ServerDeps, hub: WsHub): void {
  const sessions = sessionsRepository(deps.db);
  const wsAuth = verifyWsAuth(deps.db, { webOrigin: deps.webOrigin });

  app.get("/v1/ws", { websocket: true, preHandler: wsAuth }, (socket, req) => {
    try {
      const principal = req.agent ? ({ kind: "agent", id: req.agent.doc._id } as const) : ({ kind: "owner", id: req.owner!._id } as const);
      if (principal.kind === "agent") hub.identifyAgent(socket, principal.id);
      else hub.identifyOwner(socket, principal.id);

      send(socket, { type: "ready", principal });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[ws-diag] wsHandler synchronous setup threw", err);
      throw err;
    }

    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const pingTimer = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, PING_INTERVAL_MS);

    socket.on("message", (raw) => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return sendError(socket, undefined, "validation_failed", "Frame is not valid JSON");
        }
        const frameId = typeof parsed === "object" && parsed && "id" in parsed && typeof (parsed as { id: unknown }).id === "string" ? (parsed as { id: string }).id : undefined;
        const result = ClientFrame.safeParse(parsed);
        if (!result.success) {
          return sendError(socket, frameId, "validation_failed", result.error.issues[0]?.message ?? "Invalid frame");
        }
        const clientFrame = result.data;

        if (clientFrame.type === "ping") return send(socket, { type: "pong", id: clientFrame.id });

        if (clientFrame.type === "subscribe") {
          const session = await sessions.findById(clientFrame.sessionId);
          if (!session || !canAccessSession(session, req)) {
            return sendError(socket, clientFrame.id, "not_found", "Session not found");
          }
          hub.subscribe(socket, clientFrame.sessionId);
          const backlog = await findMessagesBySession(deps.db, clientFrame.sessionId, { afterSeq: clientFrame.afterSeq ?? 0, limit: BACKLOG_LIMIT });
          for (const m of backlog) send(socket, { type: "message", sessionId: clientFrame.sessionId, message: messageView(m) });
          return send(socket, { type: "ack", id: clientFrame.id, result: { sessionId: clientFrame.sessionId, subscribed: true } });
        }

        if (clientFrame.type === "unsubscribe") {
          hub.unsubscribe(socket, clientFrame.sessionId);
          return send(socket, { type: "ack", id: clientFrame.id, result: { sessionId: clientFrame.sessionId, subscribed: false } });
        }

        // message.send
        if (!req.agent) return sendError(socket, clientFrame.id, "unauthenticated", "Only agents can send messages");
        const agentDoc = req.agent.doc;
        const perAgent = await checkRateLimit(deps.db, "message_send_per_agent", agentDoc._id);
        const perSession = perAgent.limited ? undefined : await checkRateLimit(deps.db, "message_send_per_session", `${agentDoc._id}:${clientFrame.sessionId}`);
        const limited = perAgent.limited ? perAgent : perSession?.limited ? perSession : undefined;
        if (limited) {
          return sendError(socket, clientFrame.id, "rate_limited", "Rate limit exceeded", { retryAfterSec: limited.retryAfterSec });
        }

        const appendResult = await appendMessage(deps, agentDoc, clientFrame.sessionId, clientFrame);
        if (!appendResult.ok) {
          return sendError(socket, clientFrame.id, appendResult.error.code, appendResult.error.message, appendResult.error.details);
        }
        return send(socket, { type: "ack", id: clientFrame.id, result: { message: messageView(appendResult.message), head: appendResult.head } });
      })();
    });

    socket.on("close", () => {
      clearInterval(pingTimer);
      hub.removeConnection(socket);
    });
  });
}
