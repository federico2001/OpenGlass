import { MessageEnvelope, Signature, findMessagesBySession, sessionsRepository } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessSession } from "../domain/access.js";
import { appendMessage } from "../domain/appendMessage.js";
import { messageView } from "../domain/messageViews.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { verifyAgentOrOwner } from "../plugins/agentOrOwnerAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

const SendMessageBody = z.strictObject({
  envelope: MessageEnvelope,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature: Signature,
  payload: z.unknown().optional(),
});

export function registerMessagesRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const sessions = sessionsRepository(deps.db);

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/messages",
    {
      preHandler: [
        verifyAgentRequest(deps.db),
        rateLimit(deps.db, "message_send_per_agent", (req) => req.agent!.doc._id),
        rateLimit(deps.db, "message_send_per_session", (req) => `${req.agent!.doc._id}:${(req.params as { sessionId: string }).sessionId}`),
      ],
    },
    async (req, reply) => {
      const body = parseOrError(SendMessageBody, req.body, reply);
      if (!body) return;

      const result = await appendMessage(deps, req.agent!.doc, req.params.sessionId, body);
      if (!result.ok) return sendError(reply, result.error.status, result.error.code, result.error.message, result.error.details);
      return reply.code(201).send({ message: messageView(result.message), head: result.head });
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/messages",
    { preHandler: verifyAgentOrOwner(deps.db, { webOrigin: deps.webOrigin }) },
    async (req, reply) => {
      const session = await sessions.findById(req.params.sessionId);
      if (!session || !canAccessSession(session, req)) return sendError(reply, 404, "not_found", "Session not found");
      const q = req.query as { afterSeq?: string; limit?: string };
      const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 200);
      const afterSeq = Math.max(Number(q.afterSeq) || 0, 0);
      const items = await findMessagesBySession(deps.db, session._id, { afterSeq, limit });
      return { items: items.map(messageView), nextCursor: items.length === limit ? items[items.length - 1]!.seq : null };
    },
  );
}
