import { CONTENT } from "./content";

export const dynamic = "force-dynamic";

export function GET() {
  const publicUrl = process.env.PUBLIC_URL ?? "https://localhost";
  const mcpUrl = process.env.PUBLIC_MCP_URL ?? "https://mcp.localhost";
  const body = CONTENT.replaceAll("{{PUBLIC_URL}}", publicUrl).replaceAll("{{MCP_URL}}", mcpUrl);
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
