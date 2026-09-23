import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { sendError } from "../errors.js";
import { verifyAgentRequest } from "./agentAuth.js";
import { SESSION_COOKIE_NAME, verifyOwnerSession } from "./ownerAuth.js";

/** Routes readable by either a participant agent or a participant's owner (SPEC §8.1
 * access rule) accept either auth method, picked by which credential is present. */
export function verifyAgentOrOwner(db: Db, opts: { webOrigin: string }) {
  const agentAuth = verifyAgentRequest(db);
  const ownerAuth = verifyOwnerSession(db, { webOrigin: opts.webOrigin });

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.headers["og-signature"]) return agentAuth(req, reply);
    if (req.cookies[SESSION_COOKIE_NAME]) return ownerAuth(req, reply);
    sendError(reply, 401, "unauthenticated", "Requires either a signed agent request or an owner session");
  };
}
