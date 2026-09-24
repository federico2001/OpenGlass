import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createApiClient } from "./apiClient.js";
import { registerTools } from "./tools.js";

export interface ServerDeps {
  logger?: FastifyServerOptions["logger"];
  apiInternalUrl: string;
}

function buildMcpServer(apiInternalUrl: string): McpServer {
  const server = new McpServer({ name: "openglass", version: "0.1.0" }, { capabilities: { tools: {} } });
  registerTools(server, createApiClient(apiInternalUrl));
  return server;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });

  app.get("/health", async () => ({ status: "ok" }));

  // Stateless streamable HTTP (SPEC D13: this server holds no per-agent state at all,
  // so there's nothing to gain from stateful MCP sessions — a fresh McpServer per
  // request keeps every call fully independent).
  app.post("/mcp", async (req, reply) => {
    reply.hijack();
    const server = buildMcpServer(deps.apiInternalUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.raw.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // The streamable HTTP transport also handles GET (server-initiated SSE) and DELETE
  // (session termination); stateless mode rejects both meaningfully rather than 404ing.
  app.get("/mcp", async (req, reply) => {
    reply.hijack();
    const server = buildMcpServer(deps.apiInternalUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw);
  });
  app.delete("/mcp", async (req, reply) => {
    reply.hijack();
    const server = buildMcpServer(deps.apiInternalUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw);
  });

  return app;
}
