import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable, Transform } from "node:stream";
import { NetError, dispatcherFor, resolvePublic, type NetPolicy } from "../net.js";
import { InspectError } from "./common.js";
import type { ContentKind, FetchFacts } from "./content.js";

/**
 * The one fetch tool 1 makes: a single URL, GET only, no subresources, no browser. Built on
 * checkup's SSRF guard (net.ts): every connection resolves the host itself, refuses it if
 * any address is private/loopback/link-local/CGNAT/reserved (IPv4 and IPv6, mapped forms
 * included), and connects to the exact address it checked. On top of that, this module:
 *
 * - allows http/https on their default ports only, and refuses userinfo in the URL;
 * - re-checks every redirect hop the same way, up to MAX_REDIRECTS;
 * - runs the whole exchange, body included, under one timeout;
 * - reads at most maxBytes of decoded body, decompressing gzip/deflate/br itself, as a
 *   stream, and stopping at the cap (bounded decompression; a short read is marked truncated);
 * - accepts HTML and plain-text responses only (no other formats in v1).
 *
 * The per-target rate limit and the global concurrency cap live in limiter.ts.
 */

export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;

export interface InspectFetchOptions {
  policy: NetPolicy;
  maxBytes?: number;
  timeoutMs?: number;
  /** Tests only: the fake target listens on a random port. Never set in a deployment. */
  allowAnyPort?: boolean;
}

export interface InspectFetchResult {
  kind: ContentKind;
  bytes: Buffer;
  truncated: boolean;
  charset: string;
  facts: FetchFacts;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

export function checkInspectUrl(raw: string, allowAnyPort = false): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InspectError("bad_url", "That isn't a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new InspectError("bad_url", "Only http and https URLs are fetched.");
  if (url.username || url.password) throw new InspectError("bad_url", "URLs with a username or password are not fetched.");
  if (!allowAnyPort && url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new InspectError("bad_port", "Only the standard ports (80 and 443) are fetched.");
  }
  return url;
}

function fromNet(err: NetError): InspectError {
  const messages: Record<string, string> = {
    blocked_address: "That host resolves to a private, loopback, link-local or reserved address, which is not fetched.",
    dns_failed: "That host does not resolve.",
  };
  return new InspectError(err.code, messages[err.code] ?? err.message, err.code === "blocked_address" ? 400 : 502);
}

export async function fetchForInspection(rawUrl: string, opts: InspectFetchOptions): Promise<InspectFetchResult> {
  const maxBytes = Math.min(opts.maxBytes ?? MAX_FETCH_BYTES, MAX_FETCH_BYTES);
  const timeoutMs = opts.timeoutMs ?? opts.policy.timeoutMs ?? FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const first = checkInspectUrl(rawUrl, opts.allowAnyPort);
  const redirects: string[] = [];
  let url = first;
  const dispatcher = dispatcherFor(opts.policy);
  try {
    for (;;) {
      // Fail fast with a clear code; the dispatcher's own lookup re-checks at connect time.
      await resolvePublic(url.hostname, opts.policy);
      const res = await dispatcher.request({
        origin: url.origin,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "user-agent": opts.policy.userAgent,
          accept: "text/html, application/xhtml+xml, text/plain;q=0.9, text/markdown;q=0.9",
          "accept-encoding": "gzip, deflate, br",
        },
        signal,
      });
      // Destroying an unread body makes it emit an abort error; that's expected here.
      res.body.on("error", () => {});
      const header = (name: string) => {
        const v = res.headers[name];
        return Array.isArray(v) ? v.join(", ") : (v ?? null);
      };
      const location = header("location");
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.body.destroy();
        if (redirects.length >= MAX_REDIRECTS) throw new InspectError("too_many_redirects", `More than ${MAX_REDIRECTS} redirects.`, 502);
        let next: string;
        try {
          next = new URL(location, url).toString();
        } catch {
          throw new InspectError("bad_redirect", "The server redirected to an invalid URL.", 502);
        }
        url = checkInspectUrl(next, opts.allowAnyPort);
        redirects.push(url.toString());
        continue;
      }

      const contentType = header("content-type");
      const mediaType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
      const kind: ContentKind | null = HTML_TYPES.has(mediaType) ? "html" : TEXT_TYPES.has(mediaType) ? "text" : null;
      if (!kind) {
        res.body.destroy();
        throw new InspectError("unsupported_type", `Only HTML and plain-text responses are inspected; this one is ${mediaType ? `"${mediaType.slice(0, 80)}"` : "unlabeled"}.`, 415);
      }
      const encoding = (header("content-encoding") ?? "identity").trim().toLowerCase();
      const { bytes, truncated, compressedBytes } = await readBounded(res.body, encoding, maxBytes);
      const charset = /charset\s*=\s*"?([\w.:-]{1,40})/i.exec(contentType ?? "")?.[1]?.toLowerCase() ?? "utf-8";
      return {
        kind,
        bytes,
        truncated,
        charset,
        facts: {
          url: first.toString(),
          finalUrl: url.toString(),
          redirects,
          status: res.statusCode,
          contentType: contentType ? contentType.slice(0, 200) : null,
          compressedBytes: encoding === "identity" ? null : compressedBytes,
          contentEncoding: encoding === "identity" ? null : encoding,
        },
      };
    }
  } catch (err) {
    if (err instanceof InspectError) throw err;
    if (err instanceof NetError) throw fromNet(err);
    if (signal.aborted) throw new InspectError("timeout", `No complete response within ${timeoutMs / 1000} seconds.`, 504);
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof NetError) throw fromNet(cause);
    const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? (err as NodeJS.ErrnoException)?.code;
    if (code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) throw new InspectError("tls_failed", "The TLS certificate could not be verified.", 502);
    throw new InspectError("network", code ? `The connection failed (${code}).` : "The connection failed.", 502);
  }
}

function decompressor(encoding: string): Transform | null {
  if (encoding === "identity" || encoding === "") return null;
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  throw new InspectError("unsupported_encoding", "The response uses a content encoding this tool doesn't read.", 415);
}

/** Reads at most `maxBytes` of decoded body. Compressed input is decompressed as a stream
 * and abandoned as soon as the decoded output reaches the cap, so a small compressed body
 * can't expand without bound. The compressed side is capped at `maxBytes` too. */
async function readBounded(body: Readable, encoding: string, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean; compressedBytes: number }> {
  const inflate = decompressor(encoding);
  let compressedBytes = 0;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const source: AsyncIterable<Buffer> = inflate ? inflate : body;
  if (inflate) {
    body.on("data", (chunk: Buffer) => {
      compressedBytes += chunk.length;
      if (compressedBytes > maxBytes) {
        truncated = true;
        body.destroy();
        inflate.end();
      }
    });
    body.on("error", (err) => inflate.destroy(err));
    body.pipe(inflate);
  }
  try {
    for await (const chunk of source) {
      if (!inflate) compressedBytes += chunk.length;
      const room = maxBytes - size;
      if (chunk.length >= room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        // Exactly at the cap with nothing after it isn't a truncation, but there's no way to
        // know without reading on, so a body of exactly maxBytes is reported as truncated.
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } catch (err) {
    if (!truncated) {
      if ((err as NodeJS.ErrnoException).code?.startsWith("Z_") || (err as Error).message?.includes("decompress")) {
        throw new InspectError("bad_encoding", "The compressed response could not be decoded.", 502);
      }
      throw err;
    }
  } finally {
    body.destroy();
    inflate?.destroy();
  }
  return { bytes: Buffer.concat(chunks), truncated, compressedBytes };
}

/** Decodes with the declared charset when Node knows it, else UTF-8. */
export function decoderFor(charset: string): { decode: (b: Buffer) => string; used: string } {
  try {
    const d = new TextDecoder(charset);
    return { decode: (b) => d.decode(b), used: d.encoding };
  } catch {
    const d = new TextDecoder("utf-8");
    return { decode: (b) => d.decode(b), used: "utf-8" };
  }
}
