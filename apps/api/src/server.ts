import cookie from "@fastify/cookie";
import type { S3Client } from "@aws-sdk/client-s3";
import type { PlatformSigner } from "@openglass/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Db, MongoClient } from "mongodb";
import { registerRawBodyCapture } from "./plugins/rawBody.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerClaimsRoutes } from "./routes/claims.js";
import { registerCloseRoutes } from "./routes/close.js";
import { registerInvitesRoutes } from "./routes/invites.js";
import { registerMessagesRoutes } from "./routes/messages.js";
import { registerOwnerRoutes } from "./routes/owner.js";
import { registerRecordsRoutes } from "./routes/records.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerWellKnownRoutes } from "./routes/wellKnown.js";
import type { Mailer } from "./mailer.js";

export type HealthCheck = () => Promise<unknown>;

export interface ServerDeps {
  /** Dependency checks reported by GET /health; any failure makes it 503. */
  healthChecks: Record<string, HealthCheck>;
  logger?: FastifyServerOptions["logger"];
  db: Db;
  /** Needed for the message-append transaction (insert + conditional head advance). */
  mongoClient: MongoClient;
  signer: PlatformSigner;
  mailer: Mailer;
  publicUrl: string;
  webOrigin: string;
  s3: S3Client;
  s3Bucket: string;
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });

  registerRawBodyCapture(app);
  app.register(cookie);

  app.get("/health", async (req, reply) => {
    const results = await Promise.all(
      Object.entries(deps.healthChecks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          return [name, "ok"] as const;
        } catch (err) {
          req.log.warn({ err, check: name }, "health check failed");
          return [name, "fail"] as const;
        }
      }),
    );
    const ok = results.every(([, status]) => status === "ok");
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "fail", checks: Object.fromEntries(results) });
  });

  registerWellKnownRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerAgentsRoutes(app, deps);
  registerClaimsRoutes(app, deps);
  registerSessionsRoutes(app, deps);
  registerInvitesRoutes(app, deps);
  registerMessagesRoutes(app, deps);
  registerCloseRoutes(app, deps);
  registerOwnerRoutes(app, deps);
  registerRecordsRoutes(app, deps);
  registerVerifyRoutes(app, deps);

  return app;
}
