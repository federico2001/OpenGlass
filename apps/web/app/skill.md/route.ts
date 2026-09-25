import { SKILL_MD } from "./content";

export const dynamic = "force-dynamic";

export function GET() {
  const publicUrl = process.env.PUBLIC_URL ?? "https://localhost";
  const mcpUrl = process.env.PUBLIC_MCP_URL ?? "https://mcp.localhost";
  const body = SKILL_MD.replaceAll("{{PUBLIC_URL}}", publicUrl).replaceAll("{{MCP_URL}}", mcpUrl);
  // text/plain, not text/markdown: several AI web-fetch tools refuse or mishandle less-common
  // MIME types (confirmed by a real agent's fetch failing on this exact route) — plain text
  // is universally readable and the content is still perfectly fine markdown source.
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
