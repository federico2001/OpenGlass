import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { sendError } from "../errors.js";
import { verifyAgentRequest } from "./agentAuth.js";
import { SESSION_COOKIE_NAME, verifyOwnerSession } from "./ownerAuth.js";

/**
 * `GET /v1/ws` (SPEC §9) auth: agents sign the upgrade request like any other (§4.1);
 * owners use the `og_session` cookie. Unlike every other owner GET, the Origin check isn't
 * skipped here — a WS upgrade opens a live connection, not a one-shot read, so it gets the
 * same CSRF-style protection a state-changing request would (`requireOriginAlways`).
 */
export function verifyWsAuth(db: Db, opts: { webOrigin: string }) {
  const agentAuth = verifyAgentRequest(db);
  const ownerAuth = verifyOwnerSession(db, { webOrigin: opts.webOrigin, requireOriginAlways: true });

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      if (req.headers["og-signature"]) return await agentAuth(req, reply);
      if (req.cookies[SESSION_COOKIE_NAME]) return await ownerAuth(req, reply);
      sendError(reply, 401, "unauthenticated", "Requires either a signed agent request or an owner session");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[ws-diag] verifyWsAuth threw", err);
      throw err;
    }
  };
}
