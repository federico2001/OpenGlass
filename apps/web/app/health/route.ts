// Container healthcheck for the web service. Public /health is routed to the api by Caddy.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
