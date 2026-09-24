import { loginTokensRepository, newId, ownersRepository, webSessionsRepository } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateToken, hashToken } from "../domain/tokens.js";
import { parseOrError } from "../errors.js";
import { rateLimit } from "../plugins/rateLimit.js";
import { SESSION_COOKIE_NAME, verifyOwnerSession } from "../plugins/ownerAuth.js";
import type { ServerDeps } from "../server.js";

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const WEB_SESSION_TTL_MS = 30 * 24 * 3_600_000;

const SendEmailBody = z.strictObject({
  email: z.string().email().max(254),
  redirectTo: z
    .string()
    .max(512)
    .refine((v) => v.startsWith("/"), "redirectTo must be a same-origin relative path"),
});

export function registerAuthRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const loginTokens = loginTokensRepository(deps.db);
  const webSessions = webSessionsRepository(deps.db);
  const owners = ownersRepository(deps.db);

  app.post(
    "/v1/auth/email",
    {
      preHandler: [
        rateLimit(deps.db, "auth_email_per_email", (req) => (req.body as { email?: string } | undefined)?.email?.toLowerCase() ?? "unknown"),
        rateLimit(deps.db, "auth_email_per_ip", (req) => req.ip),
      ],
    },
    async (req, reply) => {
      const body = parseOrError(SendEmailBody, req.body, reply);
      if (!body) return;

      const email = body.email.toLowerCase();
      const token = generateToken(32);
      await loginTokens.insert({
        _id: hashToken(token),
        email,
        redirectTo: body.redirectTo,
        expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
        createdAt: new Date(),
      });
      const url = `${deps.publicUrl}/v1/auth/verify?token=${token}`;
      await deps.mailer.sendMagicLink(email, url).catch((err) => req.log.error({ err }, "failed to send magic link"));

      // Always 202, regardless of whether an owner exists for this email yet, or whether
      // the send above succeeded — this can't be used to discover which emails have
      // accounts (SPEC §4.2 step 1).
      reply.code(202).send({});
    },
  );

  app.get<{ Querystring: { token?: string } }>("/v1/auth/verify", async (req, reply) => {
    const token = req.query.token;
    const invalid = () => reply.redirect(`${deps.webOrigin}/login?error=invalid_token`, 302);
    if (!token) return invalid();

    const record = await loginTokens.findAndDelete(hashToken(token));
    if (!record || record.expiresAt.getTime() < Date.now()) return invalid();

    let owner = await owners.findByEmail(record.email);
    const now = new Date();
    if (!owner) {
      owner = await owners.insert({
        _id: newId("own"),
        email: record.email,
        displayName: null,
        settings: { requireInviteApproval: false, emailOnRecord: true },
        status: "active",
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });
    } else {
      await owners.update(owner._id, { lastLoginAt: now });
    }

    const sessionToken = generateToken(32);
    await webSessions.insert({
      _id: hashToken(sessionToken),
      ownerId: owner._id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + WEB_SESSION_TTL_MS),
    });

    reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: WEB_SESSION_TTL_MS / 1000,
    });
    return reply.redirect(`${deps.webOrigin}${record.redirectTo}`, 302);
  });

  app.post("/v1/auth/logout", { preHandler: verifyOwnerSession(deps.db, { webOrigin: deps.webOrigin }) }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE_NAME];
    if (token) await webSessions.deleteByTokenHash(hashToken(token));
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    reply.code(204).send();
  });
}
