import { gzipSync, brotliCompressSync } from "node:zlib";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetPolicy } from "../../src/net.js";
import { checkInspectUrl, fetchForInspection, MAX_FETCH_BYTES } from "../../src/inspect/fetch.js";
import { FetchLimiter } from "../../src/inspect/limiter.js";
import { inspectRoutes } from "../../src/inspect/routes.js";
import { startFakeTarget, type FakeTarget } from "../fakeTarget.js";
import { rule } from "./helpers.js";

// The fake target listens on 127.0.0.1. `onlyLocal` allows exactly that address and nothing
// else, so a redirect to 127.0.0.2 (also loopback, also reachable) proves each hop is
// re-checked. `production` is the real policy: loopback and private addresses refused.
const onlyLocal: NetPolicy = { allowPrivateAddresses: false, userAgent: "test", isAllowed: (a) => a === "127.0.0.1", timeoutMs: 2_000 };
const production: NetPolicy = { allowPrivateAddresses: false, userAgent: "test", timeoutMs: 2_000 };
const local = { policy: onlyLocal, allowAnyPort: true };

let target: FakeTarget;
beforeAll(async () => {
  target = await startFakeTarget({
    routes: {
      "/page": (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end('<p>Hi</p><div style="display:none">hidden words</div><img src="https://img.example/a.png"><script src="https://js.example/a.js"></script>');
      },
      "/text": (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("zero​width");
      },
      "/redirect-ok": (_req, res) => {
        res.writeHead(302, { location: "/page" });
        res.end();
      },
      "/redirect-private": (_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.2:${target.port}/page` });
        res.end();
      },
      "/redirect-loop": (_req, res) => {
        res.writeHead(302, { location: "/redirect-loop" });
        res.end();
      },
      "/redirect-file": (_req, res) => {
        res.writeHead(302, { location: "file:///etc/passwd" });
        res.end();
      },
      "/big": (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(MAX_FETCH_BYTES + 500_000));
      },
      "/bomb": (_req, res) => {
        // ~40 KB on the wire, 64 MB decompressed.
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x61)));
      },
      "/br": (_req, res) => {
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
        res.end(brotliCompressSync(Buffer.from("<!-- compressed comment --><p>x</p>")));
      },
      "/zstd": (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" });
        res.end("whatever");
      },
      "/pdf": (_req, res) => {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end("%PDF-1.7");
      },
      "/hang": () => {
        /* never answers */
      },
    },
  });
});
afterAll(async () => {
  await target.close();
});

describe("URL checks before any connection", () => {
  it.each([
    ["file:///etc/passwd", "bad_url"],
    ["ftp://example.com/x", "bad_url"],
    ["javascript:alert(1)", "bad_url"],
    ["not a url", "bad_url"],
    ["https://user:pass@example.com/", "bad_url"],
    ["https://user@example.com/", "bad_url"],
    ["https://example.com:8443/", "bad_port"],
    ["http://example.com:22/", "bad_port"],
  ])("%s → %s", (url, code) => {
    expect(() => checkInspectUrl(url)).toThrow(expect.objectContaining({ code }));
  });

  it("standard ports are fine", () => {
    expect(checkInspectUrl("https://example.com/").hostname).toBe("example.com");
    expect(checkInspectUrl("http://example.com:80/").hostname).toBe("example.com");
    expect(checkInspectUrl("https://example.com:443/").hostname).toBe("example.com");
  });
});

describe("address checks (production policy)", () => {
  it.each([
    "http://127.0.0.1/",
    "http://localhost/",
    "http://10.0.0.5/",
    "http://172.16.3.4/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://[64:ff9b::a00:1]/",
    "http://240.0.0.1/",
  ])("%s is refused", async (url) => {
    await expect(fetchForInspection(url, { policy: production })).rejects.toMatchObject({ code: "blocked_address" });
  });
});

describe("fetching", () => {
  it("fetches one HTML page and nothing it references", async () => {
    const before = target.requests.length;
    const r = await fetchForInspection(`${target.url}/page`, local);
    expect(r.kind).toBe("html");
    expect(r.bytes.toString()).toContain("hidden words");
    expect(target.requests.length - before).toBe(1);
    expect(target.requests.at(-1)).toMatchObject({ method: "GET", path: "/page" });
  });

  it("follows a redirect only after re-checking where it points", async () => {
    const ok = await fetchForInspection(`${target.url}/redirect-ok`, local);
    expect(ok.facts.redirects).toEqual([`${target.url}/page`]);
    await expect(fetchForInspection(`${target.url}/redirect-private`, local)).rejects.toMatchObject({ code: "blocked_address" });
    await expect(fetchForInspection(`${target.url}/redirect-file`, local)).rejects.toMatchObject({ code: "bad_url" });
    await expect(fetchForInspection(`${target.url}/redirect-loop`, local)).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("caps an oversized body at 2 MB and marks it truncated", async () => {
    const r = await fetchForInspection(`${target.url}/big`, local);
    expect(r.bytes.length).toBe(MAX_FETCH_BYTES);
    expect(r.truncated).toBe(true);
  });

  it("bounds decompression: a gzip bomb stops at the cap", async () => {
    const r = await fetchForInspection(`${target.url}/bomb`, local);
    expect(r.bytes.length).toBe(MAX_FETCH_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.facts.contentEncoding).toBe("gzip");
    expect(r.facts.compressedBytes!).toBeLessThan(MAX_FETCH_BYTES);
  });

  it("reads brotli; refuses encodings and media types it doesn't handle", async () => {
    const br = await fetchForInspection(`${target.url}/br`, local);
    expect(br.bytes.toString()).toContain("compressed comment");
    await expect(fetchForInspection(`${target.url}/zstd`, local)).rejects.toMatchObject({ code: "unsupported_encoding" });
    await expect(fetchForInspection(`${target.url}/pdf`, local)).rejects.toMatchObject({ code: "unsupported_type" });
  });

  it("one overall timeout", async () => {
    await expect(fetchForInspection(`${target.url}/hang`, { ...local, timeoutMs: 500 })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("limiter", () => {
  it("per-target rate limit, per rolling minute", () => {
    let now = 0;
    const l = new FetchLimiter(2, 10, () => now);
    l.acquire("a.example")();
    l.acquire("A.example")();
    expect(() => l.acquire("a.example")).toThrow(expect.objectContaining({ code: "rate_limited", status: 429 }));
    l.acquire("b.example")();
    now = 60_001;
    expect(() => l.acquire("a.example")()).not.toThrow();
  });

  it("global concurrency cap, released when a fetch ends", () => {
    const l = new FetchLimiter(100, 2);
    const r1 = l.acquire("a.example");
    l.acquire("b.example");
    expect(() => l.acquire("c.example")).toThrow(expect.objectContaining({ code: "busy", status: 503 }));
    r1();
    r1(); // releasing twice frees one slot, not two
    l.acquire("c.example");
    expect(() => l.acquire("d.example")).toThrow(expect.objectContaining({ code: "busy" }));
  });
});

describe("routes", () => {
  const app = Fastify({ logger: false });
  beforeAll(async () => {
    app.register(inspectRoutes, { net: onlyLocal, limiter: new FetchLimiter(1000, 4), allowAnyPort: true });
    await app.ready();
  });
  afterAll(() => app.close());

  it("JSON: fetches a URL and reports, with limits and unfetched externals", async () => {
    const res = await app.inject({ method: "POST", url: "/api/inspect/content", payload: { url: `${target.url}/page` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const r = res.json();
    expect(r.input).toMatchObject({ kind: "html", source: "url", truncated: false });
    expect(rule(r, "hidden.display-none")!.items[0]!.quote).toBe("hidden words");
    expect(r.limits.unfetched).toMatchObject({ scripts: 1, images: 1 });
    expect(r.limits.notes.join(" ")).toMatch(/Only the one URL was fetched/);
  });

  it("JSON: plain text from a URL gets the text checks", async () => {
    const r = (await app.inject({ method: "POST", url: "/api/inspect/content", payload: { url: `${target.url}/text` } })).json();
    expect(r.input.kind).toBe("text");
    expect(rule(r, "unicode.zero-width")!.count).toBe(1);
  });

  it("JSON: exactly one of html, text, url", async () => {
    for (const payload of [{}, { html: "a", text: "b" }, { html: "" }]) {
      const res = await app.inject({ method: "POST", url: "/api/inspect/content", payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    }
  });

  it("JSON: refused URLs come back as clear errors", async () => {
    const res = await app.inject({ method: "POST", url: "/api/inspect/content", payload: { url: `${target.url}/redirect-private` } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "blocked_address" });
  });

  it("JSON: invalid JSON body is a 400 that doesn't echo it", async () => {
    const res = await app.inject({ method: "POST", url: "/api/inspect/mcp-config", headers: { "content-type": "application/json" }, payload: '{"config": "ghp_SHOULDNOTECHO' });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("SHOULDNOTECHO");
  });

  it("JSON: MCP config as a string or an object", async () => {
    const config = { mcpServers: { a: { command: "npx", args: ["-y", "pkg"] } } };
    for (const c of [config, JSON.stringify(config)]) {
      const r = (await app.inject({ method: "POST", url: "/api/inspect/mcp-config", payload: { config: c } })).json();
      expect(rule(r, "mcp.unpinned-package")!.count).toBe(1);
    }
    const bad = await app.inject({ method: "POST", url: "/api/inspect/mcp-config", payload: { config: "{nope" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("bad_json");
  });

  it("form: renders the report in the response with a no-script CSP, escaping everything", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/inspect/content",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ mode: "html", content: '<div hidden><script>alert(1)</script>"><img src=x onerror=alert(2)></div><!-- <b>c</b> -->' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("<img src=x");
    expect(res.body).not.toContain("<script>alert");
    expect(res.body).toContain("&lt;b&gt;c&lt;/b&gt;");
  });

  it("form: MCP config errors re-show the form with the message", async () => {
    const res = await app.inject({ method: "POST", url: "/inspect/mcp-config", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "config=%7Bbad" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("isn&#39;t valid JSON");
  });

  it("GET pages render", async () => {
    for (const url of ["/inspect", "/inspect/content", "/inspect/mcp-config", "/assets/inspect.css"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
  });

  it("oversized request bodies are refused with 413", async () => {
    const res = await app.inject({ method: "POST", url: "/api/inspect/mcp-config", payload: { config: "x".repeat(5 * 1024 * 1024) } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("too_large");
  });

  it("never logs request bodies", async () => {
    const lines: string[] = [];
    const logged = Fastify({ logger: { level: "trace", stream: { write: (l: string) => lines.push(l) } } });
    logged.register(inspectRoutes, { net: onlyLocal, limiter: new FetchLimiter(1000, 4), allowAnyPort: true });
    await logged.inject({ method: "POST", url: "/api/inspect/content", payload: { html: "<p>BODY-MARKER-1</p>" } });
    await logged.inject({ method: "POST", url: "/api/inspect/mcp-config", payload: { config: '{"BODY-MARKER-2": ' } });
    await logged.inject({ method: "POST", url: "/inspect/content", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "mode=text&content=BODY-MARKER-3" });
    await logged.close();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/BODY-MARKER/);
  });
});
