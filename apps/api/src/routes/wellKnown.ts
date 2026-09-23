import type { FastifyInstance } from "fastify";
import { trustedPlatformKeys } from "../domain/platformKeys.js";
import type { ServerDeps } from "../server.js";

export function registerWellKnownRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/.well-known/openglass-keys.json", async () => ({ keys: await trustedPlatformKeys(deps.signer) }));
}
