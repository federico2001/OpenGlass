import { RecordBundle, verifyBundle } from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { trustedPlatformKeys } from "../domain/platformKeys.js";
import { parseOrError } from "../errors.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

/** SPEC §7.6 / §8.2: anyone can submit a bundle here; it's verified against the server's
 * own trusted platform keys (never the bundle's own `platformKeys`, which is only a hint). */
export function registerVerifyRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post("/v1/verify", { preHandler: rateLimit(deps.db, "verify", (req) => req.ip) }, async (req, reply) => {
    const bundle = parseOrError(RecordBundle, req.body, reply);
    if (!bundle) return;
    const trusted = await trustedPlatformKeys(deps.signer);
    const result = verifyBundle(bundle, trusted);
    return {
      valid: result.valid,
      errors: result.errors,
      recordId: bundle.record.statement.recordId,
      sessionId: bundle.record.statement.sessionId,
    };
  });
}
