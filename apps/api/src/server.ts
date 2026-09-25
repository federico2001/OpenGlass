import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { S3Client } from "@aws-sdk/client-s3";
import type { PlatformSigner } from "@openglass/db";
import type { RoutesConfig } from "@x402/core/server";
import { paymentMiddleware } from "@x402/fastify";
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
import { registerPremiumRoutes, requireExistingRecordForPremiumRoutes, requireWithinSpendLimit } from "./routes/premium.js";
import { registerRecordsRoutes } from "./routes/records.js";
import { registerSessionsRoutes } from "./routes/sessions.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerWellKnownRoutes } from "./routes/wellKnown.js";
import { registerWsRoutes } from "./routes/ws.js";
import { createWsHub } from "./ws/hub.js";
import type { Mailer } from "./mailer.js";
import type { X402Deps } from "./domain/x402.js";

export type HealthCheck = () => Promise<unknown>;

export interface ServerDeps {
  /** Dependency checks reported by GET /health; any failure makes it 503. */
  healthChecks: Record<string, HealthCheck>;
  logger?: FastifyServerOptions["logger"];
  db: Db;
  /** Needed for the message-append transaction (insert + conditional head advance). */
  mongoClient: MongoClient;
  signer: PlatformSigner;
  /** See domain/platformKeys.ts — must match the worker container's value. */
  platformKeyValidFrom?: string;
  mailer: Mailer;
  publicUrl: string;
  webOrigin: string;
  /** Referenced (not called) in /.well-known/agent.json — the mcp server, running on its
   * own subdomain, never talks to this field's value; it's purely for discovery. */
  publicMcpUrl: string;
  s3: S3Client;
  s3Bucket: string;
  /** The records bucket's own Object Lock default mode (infra/lib/openglass-stack.ts). Used
   * only as a fallback by the extend-retention route, for the rare object with no retention
   * of its own yet — every real object already carries the mode the bucket set on upload.
   * Defaults to "COMPLIANCE", matching the infra default. */
  objectLockMode?: "GOVERNANCE" | "COMPLIANCE";
  /** x402 premium tier (Prompt 12) — null disables `/v1/premium/*` entirely. See domain/x402.ts. */
  x402: X402Deps | null;
  /** Fetches an agent's own `.well-known/openglass-agent-verification.txt` and checks for
   * its verification token (domain/domainVerification.ts's real implementation, by
   * default) — injected, rather than imported directly into the route, so tests can fake
   * the network call instead of standing up a real public HTTPS server (which the real
   * implementation's SSRF guard would refuse to fetch from anyway). */
  checkDomainVerification: (domain: string, token: string) => Promise<boolean>;
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
  app.register(websocket);

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

  const wsHub = createWsHub(deps.db);
  registerWsRoutes(app, deps, wsHub);
  app.addHook("onClose", async () => wsHub.close());

  if (deps.x402) {
    const { resourceServer, payTo, network } = deps.x402;
    const routes: RoutesConfig = {
      "POST /v1/premium/agents/me/verified-badge": {
        accepts: { scheme: "exact", network, payTo, price: "$1.00" },
        description: "Mark this agent as verified — shown on its public profile and in agent.json.",
      },
      "POST /v1/premium/records/:recordId/extend-retention": {
        accepts: { scheme: "exact", network, payTo, price: "$0.50" },
        description: "Extend a record's evidence retention (S3 Object Lock) by 10 years.",
      },
      "GET /v1/premium/records/:recordId/pdf": {
        accepts: { scheme: "exact", network, payTo, price: "$0.25" },
        description: "A human-readable PDF summary of a witnessed session record.",
      },
    };
    // See requireExistingRecordForPremiumRoutes' and requireWithinSpendLimit's own doc
    // comments: both must be registered before paymentMiddleware so they run first.
    app.addHook("onRequest", requireExistingRecordForPremiumRoutes(deps.db));
    app.addHook("onRequest", requireWithinSpendLimit(deps.db));

    paymentMiddleware(app, routes, resourceServer);
    registerPremiumRoutes(app, deps);
  }

  return app;
}
