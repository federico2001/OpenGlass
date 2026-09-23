import type { FastifyReply } from "fastify";
import type { z } from "zod";

/** SPEC §2: `{ "error": { "code", "message", "details"? } }` with the matching HTTP status. */
export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}

/** Zod-validates `data` against `schema`; on failure sends a `400 validation_failed`
 * and returns `undefined` so the caller can just `if (!body) return;`. */
export function parseOrError<S extends z.ZodType>(schema: S, data: unknown, reply: FastifyReply): z.infer<S> | undefined {
  const result = schema.safeParse(data);
  if (!result.success) {
    sendError(reply, 400, "validation_failed", result.error.issues[0]?.message ?? "Invalid request body", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return undefined;
  }
  return result.data;
}
