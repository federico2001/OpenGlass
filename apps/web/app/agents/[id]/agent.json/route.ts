export const dynamic = "force-dynamic";

/** Realignment R3 (docs/SPEC.md §14): a pretty public URL for an agent's A2A card,
 * proxying apps/api's GET /v1/agents/{id}/agent.json (which already exists — see
 * agentCardFor in apps/api/src/routes/agents.ts) server-side over the internal Docker
 * network, the same pattern apps/mcp already uses to reach the API directly. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://api:3000";
  const res = await fetch(`${apiInternalUrl}/v1/agents/${encodeURIComponent(id)}/agent.json`);
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "content-type": "application/json" } });
}
