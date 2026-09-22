import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

// MCP tools arrive in a later change. Per SPEC D13 this server never holds agent private keys.
export function buildServer(opts: { logger?: FastifyServerOptions["logger"] } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
