import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { sendError } from "../errors.js";
import { verifyOwnerSession } from "./ownerAuth.js";

/**
 * Reuses the ordinary `og_session` owner auth (no separate admin session type exists —
 * see ownerAuth.ts), then additionally requires the owner's email to be in the configured
 * allowlist (`ADMIN_EMAILS`, Prompt 23). Someone signed in but not listed gets `403`, not
 * a redirect to login: they *are* authenticated, just not authorized for this route.
 */
export function verifyAdminSession(db: Db, opts: { webOrigin: string; adminEmails: string[] }) {
  const ownerAuth = verifyOwnerSession(db, { webOrigin: opts.webOrigin });

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await ownerAuth(req, reply);
    if (reply.sent) return;
    if (!opts.adminEmails.includes(req.owner!.email)) {
      return sendError(reply, 403, "forbidden", "Not an admin");
    }
  };
}
