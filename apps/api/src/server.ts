import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export type HealthCheck = () => Promise<unknown>;

export interface ServerDeps {
  /** Dependency checks reported by GET /health; any failure makes it 503. */
  healthChecks: Record<string, HealthCheck>;
  logger?: FastifyServerOptions["logger"];
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

  return app;
}
