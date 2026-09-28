import { describe, expect, it } from "vitest";
import { OpenGlassClient } from "../src/client.js";

/**
 * Realignment R7: live-stack integration coverage for the new lookup/attestation/guard
 * surface. Same skip-if-unreachable convention as integration.test.ts.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const baseUrl = process.env.OPENGLASS_TEST_BASE_URL ?? "https://localhost";

async function isReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
const reachable = await isReachable();

describe.skipIf(!reachable)("OpenGlassClient.lookup (live stack)", () => {
  it(
    "reports an unregistered domain, then a registered-but-unclaimed agent by id",
    async () => {
      const client = new OpenGlassClient({ baseUrl });

      const miss = await client.lookup({ domain: `sdk-js-test-nobody-${Date.now()}.example` });
      expect(miss.registered).toBe(false);

      const { agent } = await client.registerAgent({ name: "sdk-js lookup test", description: "Created by sdk-js's own test suite." });
      const hit = await client.lookup({ agentId: agent.id });
      expect(hit.registered).toBe(true);
      if (hit.registered) {
        expect(hit.agentId).toBe(agent.id);
        expect(hit.claimed).toBe(false);
        expect(hit.flags.newAgent).toBe(true);
      }
    },
    15000,
  );
});

describe.skipIf(!reachable)("OpenGlassClient attestations (live stack)", () => {
  it(
    "opens, appends an event to, closes, and verifies a private attestation — no counterparty needed",
    async () => {
      const client = new OpenGlassClient({ baseUrl });
      const { claim } = await client.registerAgent({ name: "sdk-js attestation test", description: "Created by sdk-js's own test suite." });

      // Same real magic-link + claim round trip as integration.test.ts.
      const token = claim.url.split("/claim/")[1]!;
      const email = `sdk-js-attest-test-${Date.now()}@example.com`;
      await fetch(`${baseUrl}/v1/auth/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ email, redirectTo: `/claim/${token}` }),
      });
      await new Promise((r) => setTimeout(r, 700));
      const mail = (await fetch(`${baseUrl}/mailpit/api/v1/messages`).then((r) => r.json())) as { messages: { ID: string; To: { Address: string }[] }[] };
      const msg = mail.messages.find((m) => m.To[0]!.Address === email)!;
      const full = (await fetch(`${baseUrl}/mailpit/api/v1/message/${msg.ID}`).then((r) => r.json())) as { Text: string };
      const link = full.Text.match(/https:\/\/\S+\/v1\/auth\/verify\?token=\S+/)?.[0]!;
      const verifyRes = await fetch(link, { redirect: "manual" });
      const cookie = verifyRes.headers.get("set-cookie")?.match(/og_session=[^;]+/)?.[0]!;
      await fetch(`${baseUrl}/v1/claims/${token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl, cookie },
        body: "{}",
      });
      await client.waitUntilClaimed({ timeoutMs: 15000 });

      // Explicit "shared" so the record's full bundle is available immediately — this test
      // exercises the attest -> event -> close -> bundle -> verify round trip, not the
      // separate private/sealed receipt-and-unseal ceremony (covered elsewhere).
      const { attestation } = await client.openAttestation({ purpose: "sdk-js attestation test.", visibility: "shared" });
      expect(attestation.status).toBe("active");
      expect(attestation.visibility).toBe("shared");

      const { head } = await client.sendAttestationEvent(attestation.id, { text: "Did the thing." });
      expect(head.seq).toBe(1);

      await client.closeAttestation(attestation.id);
      const recordId = await client.waitForAttestationRecord(attestation.id, { timeoutMs: 20000 });
      expect(recordId).toBeTruthy();

      // A private record: the owner (this same claimed identity) can still fetch and
      // locally verify the bundle, same verify() path a session record uses.
      const bundle = await client.getRecordBundle(recordId);
      const result = await client.verify(bundle);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    },
    30000,
  );
});

describe.skipIf(!reachable)("OpenGlassClient.guard (live stack)", () => {
  it("allows low-risk actions without ever calling OpenGlass", async () => {
    const client = new OpenGlassClient({ baseUrl: "https://this-host-does-not-resolve.invalid" });
    const result = await client.guard({ risk: "low", counterpartyAgentId: "agt_whatever" });
    expect(result.action).toBe("allow");
    expect(result.reason).toContain("below the check threshold");
  });

  it("fails open when OpenGlass is unreachable for a high-risk check", async () => {
    const client = new OpenGlassClient({ baseUrl: "https://this-host-does-not-resolve.invalid" });
    const result = await client.guard({ risk: "high", counterpartyAgentId: "agt_whatever" });
    expect(result.action).toBe("allow");
    expect(result.reason).toContain("failing open");
  });

  it("allows a brand-new counterparty that hasn't claimed any domain, by default", async () => {
    const client = new OpenGlassClient({ baseUrl });
    const { agent } = await client.registerAgent({ name: "sdk-js guard test counterparty", description: "Created by sdk-js's own test suite." });
    // unverifiedDomain only fires when meta.homepage is set but not verified — an agent
    // with no domain claim at all isn't inherently suspicious, just new.
    const result = await client.guard({ risk: "high", counterpartyAgentId: agent.id });
    expect(result.action).toBe("allow");
    expect(result.reason).toContain("first time seeing this counterparty");
    expect(result.lookup?.registered).toBe(true);
  });

  it("warns on a counterparty whose claimed domain isn't verified", async () => {
    const client = new OpenGlassClient({ baseUrl });
    const { agent } = await client.registerAgent({
      name: "sdk-js guard test counterparty (unverified domain)",
      description: "Created by sdk-js's own test suite.",
      meta: { homepage: `https://sdk-js-guard-test-${Date.now()}.example` },
    });
    const result = await client.guard({ risk: "high", counterpartyAgentId: agent.id });
    expect(result.action).toBe("warn");
    expect(result.reason).toContain("domain is not verified");
  });
});
