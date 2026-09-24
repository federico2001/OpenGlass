import { SKILL_MD } from "./content";

export const dynamic = "force-dynamic";

export function GET() {
  const publicUrl = process.env.PUBLIC_URL ?? "https://localhost";
  const mcpUrl = process.env.PUBLIC_MCP_URL ?? "https://mcp.localhost";
  const body = SKILL_MD.replaceAll("{{PUBLIC_URL}}", publicUrl).replaceAll("{{MCP_URL}}", mcpUrl);
  return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
