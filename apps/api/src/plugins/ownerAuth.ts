import { ownersRepository, webSessionsRepository, type OwnerDoc } from "@openglass/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { hashToken } from "../domain/tokens.js";
import { sendError } from "../errors.js";

export const SESSION_COOKIE_NAME = "og_session";

declare module "fastify" {
  interface FastifyRequest {
    owner?: OwnerDoc;
  }
}

/**
 * SPEC §4.2: owners authenticate via the `og_session` cookie. State-changing requests
 * must additionally send a matching `Origin` and `Content-Type: application/json`
 * (`webOrigin` is the configured web app origin — `checkOrigin` is skipped for `GET`).
 */
export function verifyOwnerSession(db: Db, opts: { webOrigin: string }) {
  const owners = ownersRepository(db);
  const webSessions = webSessionsRepository(db);

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.method !== "GET") {
      if (req.headers.origin !== opts.webOrigin) {
        return sendError(reply, 403, "origin_not_allowed", "Origin header does not match the configured web origin");
      }
      const contentType = req.headers["content-type"];
      if (!contentType?.startsWith("application/json")) {
        return sendError(reply, 400, "bad_request", "Content-Type must be application/json");
      }
    }

    const token = req.cookies[SESSION_COOKIE_NAME];
    if (!token) return sendError(reply, 401, "unauthenticated", "Missing session cookie");

    const session = await webSessions.findByTokenHash(hashToken(token));
    if (!session || session.expiresAt.getTime() < Date.now()) {
      return sendError(reply, 401, "unauthenticated", "Session is missing, expired, or invalid");
    }

    const owner = await owners.findById(session.ownerId);
    if (!owner || owner.status !== "active") {
      return sendError(reply, 401, "unauthenticated", "Owner not found or disabled");
    }
    req.owner = owner;
  };
}
