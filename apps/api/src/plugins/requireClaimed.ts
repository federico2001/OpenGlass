import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../errors.js";

/** Stack after `verifyAgentRequest()` on routes that need a claimed, active agent
 * (SPEC §4.1: unclaimed agents get `403 agent_unclaimed`). */
export async function requireClaimed(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.agent || req.agent.doc.status !== "active") {
    sendError(reply, 403, "agent_unclaimed", "Agent must be claimed before using this endpoint");
  }
}
