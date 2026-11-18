import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { createApiClient } from "./apiClient.js";
import { createInspectClient, registerInspectionTools } from "./inspectTools.js";
import { registerPublicTools, registerTools } from "./tools.js";

const OPENAI_APPS_CHALLENGE_TOKEN = "jDkvAc4OAVw7wT_YUSIZplZ87Pho_rhzxQAwvFPW6Zo";

export interface ServerDeps {
  logger?: FastifyServerOptions["logger"];
  apiInternalUrl: string;
  /** apps/checkup over the Docker network, for the two inspection tools on /mcp-public. */
  checkupInternalUrl?: string;
}

function buildMcpServer(apiInternalUrl: string): McpServer {
  const server = new McpServer({ name: "openglass", version: "0.2.0" }, { capabilities: { tools: {} } });
  registerTools(server, createApiClient(apiInternalUrl));
  return server;
}

/** Only tools that need no signing, for listings such as the ChatGPT and Claude connector
 * directories that expect no-auth (or OAuth) tools: `lookup_agent` and `verify_agent` (same
 * stateless, keyless proxy as `/mcp`), plus the two read-only inspection tools
 * (inspectTools.ts), which proxy to apps/checkup and store nothing. */
function buildPublicMcpServer(apiInternalUrl: string, checkupInternalUrl: string): McpServer {
  const server = new McpServer({ name: "openglass-public", version: "0.2.0" }, { capabilities: { tools: {} } });
  registerPublicTools(server, createApiClient(apiInternalUrl));
  registerInspectionTools(server, createInspectClient(checkupInternalUrl));
  return server;
}

type BuildMcpServer = () => McpServer;

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });

  app.get("/health", async () => ({ status: "ok" }));

  // OpenAI apps directory domain verification, in case the portal checks this origin
  // rather than openglass.glass (apps/api serves the same token there).
  app.get("/.well-known/openai-apps-challenge", async (_req, reply) =>
    reply.type("text/plain; charset=utf-8").send(OPENAI_APPS_CHALLENGE_TOKEN),
  );

  const checkupInternalUrl = deps.checkupInternalUrl ?? "http://checkup:3004";
  mountMcpEndpoint(app, "/mcp", () => buildMcpServer(deps.apiInternalUrl));
  mountMcpEndpoint(app, "/mcp-public", () => buildPublicMcpServer(deps.apiInternalUrl, checkupInternalUrl));

  return app;
}

function mountMcpEndpoint(app: FastifyInstance, path: string, build: BuildMcpServer): void {
  // Stateless streamable HTTP (SPEC D13: this server holds no per-agent state at all,
  // so there's nothing to gain from stateful MCP sessions — a fresh McpServer per
  // request keeps every call fully independent).
  app.post(path, async (req, reply) => {
    reply.hijack();
    const server = build();
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
  app.get(path, async (req, reply) => {
    reply.hijack();
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw);
  });
  app.delete(path, async (req, reply) => {
    reply.hijack();
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw);
  });
}
