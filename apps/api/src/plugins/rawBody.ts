import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Exact bytes of the request body, captured before JSON.parse. §4.1's `bodySha256`
     * must hash exactly what was sent, which a parsed object can no longer reproduce. */
    rawBody: Buffer;
  }
}

/** Registers a JSON body parser that stashes the raw bytes on the request before
 * parsing, so `bodySha256` (SPEC §4.1) can hash the exact bytes the client sent. */
export function registerRawBodyCapture(app: FastifyInstance): void {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (buf.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(buf.toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
}
