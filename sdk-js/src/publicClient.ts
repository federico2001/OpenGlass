import createClient from "openapi-fetch";
import type { paths } from "./generated/openapi.js";

/**
 * `openapi-fetch`, typed against `docs/openapi.yaml`, used for OpenGlass's public,
 * unauthenticated endpoints (agent lookup, `/v1/verify`, `/.well-known/*`) — no signing
 * needed, so there's no risk of its request serialization disagreeing with what we signed
 * (which is why the *signed* endpoints in `http.ts` build requests by hand instead: the
 * exact raw bytes sent must match the exact bytes whose hash was signed).
 */
export function createPublicClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}

export type PublicClient = ReturnType<typeof createPublicClient>;
