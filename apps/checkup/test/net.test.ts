import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress, safeFetch, type NetPolicy } from "../src/net.js";
import { startFakeTarget, type FakeTarget } from "./fakeTarget.js";

// The fake target listens on 127.0.0.1. These policies allow exactly that address and
// nothing else, so a redirect to 127.0.0.2 (also loopback, also reachable) proves the
// guard re-checks every hop.
const onlyLocal: NetPolicy = { allowPrivateAddresses: false, userAgent: "test", isAllowed: (a) => a === "127.0.0.1", timeoutMs: 1_000 };
const production: NetPolicy = { allowPrivateAddresses: false, userAgent: "test" };

let target: FakeTarget;
beforeAll(async () => {
  target = await startFakeTarget({
    routes: {
      "/redirect-private": (_req, res) => {
        res.writeHead(302, { location: `http://127.0.0.2:${target.port}/ok` });
        res.end();
      },
      "/redirect-ok": (_req, res) => {
        res.writeHead(302, { location: "/ok" });
        res.end();
      },
      "/ok": (_req, res) => res.end("ok"),
      "/big": (_req, res) => res.end("x".repeat(200_000)),
      "/hang": () => {
        /* never answers */
      },
    },
  });
});
afterAll(async () => {
  await target.close();
});

describe("isPublicAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fd00::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["64:ff9b::10.0.0.1", false],
    ["not-an-ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("safeFetch", () => {
  it("refuses loopback and private targets under the production policy", async () => {
    await expect(safeFetch(`${target.url}/ok`, { maxBytes: 1000 }, production)).rejects.toMatchObject({ code: "blocked_address" });
    await expect(safeFetch("http://localhost:1/x", { maxBytes: 1000 }, production)).rejects.toMatchObject({ code: "blocked_address" });
    await expect(safeFetch("http://[::1]:1/x", { maxBytes: 1000 }, production)).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("follows a redirect only after re-checking where it points", async () => {
    const ok = await safeFetch(`${target.url}/redirect-ok`, { maxBytes: 1000, followRedirects: true }, onlyLocal);
    expect(ok.body.toString()).toBe("ok");
    expect(ok.redirects).toEqual([`${target.url}/ok`]);
    await expect(safeFetch(`${target.url}/redirect-private`, { maxBytes: 1000, followRedirects: true }, onlyLocal)).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("never follows redirects unless asked", async () => {
    const res = await safeFetch(`${target.url}/redirect-private`, { maxBytes: 1000 }, onlyLocal);
    expect(res.status).toBe(302);
  });

  it("caps the response size and times out", async () => {
    await expect(safeFetch(`${target.url}/big`, { maxBytes: 128 * 1024 }, onlyLocal)).rejects.toMatchObject({ code: "too_large" });
    await expect(safeFetch(`${target.url}/hang`, { maxBytes: 1000 }, onlyLocal)).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses non-HTTP schemes and URLs with credentials", async () => {
    await expect(safeFetch("file:///etc/passwd", { maxBytes: 1000 }, onlyLocal)).rejects.toMatchObject({ code: "bad_url" });
    await expect(safeFetch(`http://a:b@127.0.0.1:${target.port}/ok`, { maxBytes: 1000 }, onlyLocal)).rejects.toMatchObject({ code: "bad_url" });
  });
});
