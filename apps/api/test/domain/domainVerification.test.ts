import { describe, expect, it } from "vitest";
import {
  domainFromHomepage,
  isPublicIpv4,
  isPublicIpv6,
  resolvesToPublicAddress,
  verificationFileUrl,
} from "../../src/domain/domainVerification.js";

describe("domainFromHomepage", () => {
  it("accepts a real https hostname", () => {
    expect(domainFromHomepage("https://acme.example")).toBe("acme.example");
    expect(domainFromHomepage("HTTPS://Acme.Example/path")).toBe("acme.example");
  });

  it("rejects anything that isn't a real public https hostname", () => {
    expect(domainFromHomepage(undefined)).toBeNull();
    expect(domainFromHomepage("")).toBeNull();
    expect(domainFromHomepage("http://acme.example")).toBeNull(); // not https
    expect(domainFromHomepage("not a url")).toBeNull();
    expect(domainFromHomepage("https://127.0.0.1")).toBeNull(); // IPv4 literal
    expect(domainFromHomepage("https://[::1]")).toBeNull(); // IPv6 literal
    expect(domainFromHomepage("https://localhost")).toBeNull();
    expect(domainFromHomepage("https://sub.localhost")).toBeNull();
  });
});

describe("verificationFileUrl", () => {
  it("builds the well-known path under the target domain", () => {
    expect(verificationFileUrl("acme.example")).toBe("https://acme.example/.well-known/openglass-agent-verification.txt");
  });
});

/**
 * SSRF guard (OWASP A10): an agent's own `meta.homepage` drives an outbound request the
 * platform's server makes, so every private/loopback/link-local/reserved range must be
 * refused before that request happens.
 */
describe("isPublicIpv4", () => {
  it("rejects private, loopback, link-local, and reserved ranges", () => {
    for (const ip of ["10.0.0.1", "10.255.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      expect(isPublicIpv4(ip), ip).toBe(false);
    }
  });

  it("accepts ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1"]) {
      expect(isPublicIpv4(ip), ip).toBe(true);
    }
  });
});

describe("isPublicIpv6", () => {
  it("rejects loopback, link-local, unique-local, and IPv4-mapped-private", () => {
    for (const ip of ["::1", "fe80::1", "febf::1", "fc00::1", "fd12::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1"]) {
      expect(isPublicIpv6(ip), ip).toBe(false);
    }
  });

  it("accepts an ordinary public IPv6 address", () => {
    expect(isPublicIpv6("2606:4700:4700::1111")).toBe(true); // Cloudflare public resolver
    expect(isPublicIpv6("::ffff:8.8.8.8")).toBe(true); // IPv4-mapped, but a public address
  });
});

describe("resolvesToPublicAddress", () => {
  it("refuses loopback — localhost always resolves privately, no network needed", async () => {
    expect(await resolvesToPublicAddress("localhost")).toBe(false);
  });

  it("refuses a hostname that can't be resolved at all", async () => {
    expect(await resolvesToPublicAddress("this-domain-should-not-resolve.invalid")).toBe(false);
  });
});
