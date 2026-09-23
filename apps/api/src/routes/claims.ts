import { agentsRepository } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { agentFullView, agentPublicView } from "../domain/agentViews.js";
import { hashToken } from "../domain/tokens.js";
import { sendError } from "../errors.js";
import { verifyOwnerSession } from "../plugins/ownerAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

export function registerClaimsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const agents = agentsRepository(deps.db);

  app.get<{ Params: { token: string } }>(
    "/v1/claims/:token",
    { preHandler: rateLimit(deps.db, "claim_preview", (req) => req.ip) },
    async (req, reply) => {
      const agent = await agents.findByClaimTokenHash(hashToken(req.params.token));
      if (!agent || !agent.claim || agent.claim.expiresAt.getTime() < Date.now()) {
        return sendError(reply, 404, "not_found", "Claim token is unknown, used, or expired");
      }
      return { agent: agentPublicView(agent), expiresAt: agent.claim.expiresAt.toISOString() };
    },
  );

  app.post<{ Params: { token: string } }>(
    "/v1/claims/:token/accept",
    { preHandler: [verifyOwnerSession(deps.db, { webOrigin: deps.webOrigin }), rateLimit(deps.db, "claim_accept", (req) => req.owner!._id)] },
    async (req, reply) => {
      const agent = await agents.findByClaimTokenHash(hashToken(req.params.token));
      if (!agent || !agent.claim || agent.claim.expiresAt.getTime() < Date.now()) {
        return sendError(reply, 404, "not_found", "Claim token is unknown, used, or expired");
      }
      const now = new Date();
      const updated = await agents.update(agent._id, { ownerId: req.owner!._id, status: "active", claim: null, claimedAt: now });
      return { agent: agentFullView(updated!) };
    },
  );
}
