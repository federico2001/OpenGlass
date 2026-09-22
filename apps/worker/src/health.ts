import Fastify, { type FastifyInstance } from "fastify";

/** Internal-only health endpoint for the container healthcheck (not routed by Caddy). */
export function buildHealthServer(ping: () => Promise<unknown>): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async (_req, reply) => {
    try {
      await ping();
      return { status: "ok", checks: { mongo: "ok" } };
    } catch {
      return reply.code(503).send({ status: "fail", checks: { mongo: "fail" } });
    }
  });
  return app;
}
