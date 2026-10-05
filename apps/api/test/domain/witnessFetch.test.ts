import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureHttpResponse } from "../../src/domain/witnessFetch.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/text") {
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "sess=secret" });
      res.end("hello witness");
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(200_000));
      return;
    }
    if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// captureHttpResponse has no SSRF guard of its own (that's performWitnessFetch, which
// wraps it with the resolvesToPublicAddress check already covered by
// domainVerification.test.ts) — that's exactly why it's safe to point this at a plain
// http://127.0.0.1 test server, which the guard would otherwise always refuse.

describe("captureHttpResponse", () => {
  it("captures status, an allowlisted header, and decodes a text body", async () => {
    const result = await captureHttpResponse(new URL(`${baseUrl}/text`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(200);
    expect(result.response.contentType).toBe("text/plain");
    expect(result.response.bodyText).toBe("hello witness");
    expect(result.response.bodyTruncated).toBe(false);
    expect(result.response.headers["content-type"]).toBe("text/plain");
    // Set-Cookie is never on the capture allowlist — it belongs to the target server, not
    // something OpenGlass should store or show back.
    expect(result.response.headers["set-cookie"]).toBeUndefined();
  });

  it("caps the body at MAX_RESPONSE_BYTES and still hashes exactly what it kept", async () => {
    const result = await captureHttpResponse(new URL(`${baseUrl}/big`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.bodyTruncated).toBe(true);
    expect(result.response.bodyBytes).toBe(65_536);
    expect(result.response.bodyText?.length).toBe(65_536);
  });

  it("doesn't decode a binary content type as text, but still hashes the bytes", async () => {
    const result = await captureHttpResponse(new URL(`${baseUrl}/binary`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.bodyText).toBeNull();
    expect(result.response.bodyBytes).toBe(4);
    expect(result.response.bodySha256).toHaveLength(64);
  });

  it("reports failure rather than throwing when the connection is refused", async () => {
    const result = await captureHttpResponse(new URL("http://127.0.0.1:1/"));
    expect(result.ok).toBe(false);
  });
});
