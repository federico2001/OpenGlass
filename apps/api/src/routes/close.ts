import {
  CloseStatement,
  Signature,
  base64UrlDecode,
  canonicalizeToBytes,
  sessionsRepository,
  sha256,
  verifySignature,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { participantOf } from "../domain/access.js";
import { sessionView } from "../domain/sessionViews.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

const CloseBody = z.strictObject({ statement: CloseStatement, signature: Signature });

export function registerCloseRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const sessions = sessionsRepository(deps.db);

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/close",
    { preHandler: [verifyAgentRequest(deps.db), rateLimit(deps.db, "session_close", (req) => req.agent!.doc._id)] },
    async (req, reply) => {
      const body = parseOrError(CloseBody, req.body, reply);
      if (!body) return;

      const session = await sessions.findById(req.params.sessionId);
      const participant = session && participantOf(session, req.agent!.doc._id);
      if (!session || !participant) return sendError(reply, 404, "not_found", "Session not found");
      if (session.status !== "active") return sendError(reply, 409, "session_not_active", "Session is not active");

      const { statement, signature } = body;
      if (statement.sessionId !== session._id || statement.headSeq !== session.head.seq || statement.headHash !== session.head.hash) {
        return sendError(reply, 422, "head_mismatch", "close statement does not match the current head");
      }
      const key = req.agent!.doc.keys.find((k) => k.kid === participant.kid);
      const verified =
        !!key &&
        verifySignature(
          { alg: "Ed25519", kid: key.kid, publicKey: base64UrlDecode(key.publicKey) },
          "close",
          sha256(canonicalizeToBytes(statement)),
          signature,
        );
      if (!verified) return sendError(reply, 422, "invalid_signature", "close signature does not verify");

      const updated = await sessions.update(session._id, {
        status: "closing",
        closing: { reason: "agent_closed", requestedBy: req.agent!.doc._id, statement, signature, requestedAt: new Date() },
      });
      return reply.code(202).send({ session: sessionView(updated!) });
    },
  );
}
