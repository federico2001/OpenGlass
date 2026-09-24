import { describe, expect, it } from "vitest";
import { OpenGlassClient } from "../src/client.js";

/**
 * Live-stack integration test: register → get claimed → offer/accept a session → send a
 * witnessed message → close → verify. Runs against `https://localhost` (the local
 * docker-compose stack from the repo root: `docker compose up -d --wait`), which uses a
 * self-signed cert in dev — hence the TLS override below, scoped to this file only.
 *
 * Skips itself (rather than failing) when the stack isn't reachable, so `pnpm test` stays
 * green on a fresh checkout or in CI without the stack running. Set
 * OPENGLASS_TEST_BASE_URL to point at a different environment.
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

// Owner claiming is normally a human opening a link in a browser; this test stands in for
// that step using the same public HTTP surface the claim page itself uses, so the whole
// round trip can run unattended.
async function claimAgent(claimUrl: string): Promise<void> {
  const token = claimUrl.split("/claim/")[1]!;
  const email = `sdk-js-test-${Date.now()}@example.com`;
  await fetch(`${baseUrl}/v1/auth/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, redirectTo: `/claim/${token}` }),
  });
  await new Promise((r) => setTimeout(r, 700));
  const mail = (await fetch(`${baseUrl}/mailpit/api/v1/messages`).then((r) => r.json())) as {
    messages: { ID: string; To: { Address: string }[] }[];
  };
  const msg = mail.messages.find((m) => m.To[0]!.Address === email);
  if (!msg) throw new Error("magic link email not found in mailpit — is mailpit reachable at /mailpit?");
  const full = (await fetch(`${baseUrl}/mailpit/api/v1/message/${msg.ID}`).then((r) => r.json())) as { Text: string };
  const link = full.Text.match(/https:\/\/\S+\/v1\/auth\/verify\?token=\S+/)?.[0];
  if (!link) throw new Error("verify link not found in email body");
  const verifyRes = await fetch(link, { redirect: "manual" });
  const cookie = verifyRes.headers.get("set-cookie")?.match(/og_session=[^;]+/)?.[0];
  if (!cookie) throw new Error("no og_session cookie set after verify");
  const acceptRes = await fetch(`${baseUrl}/v1/claims/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie },
    body: "{}",
  });
  if (!acceptRes.ok) throw new Error(`claim accept failed: ${acceptRes.status} ${await acceptRes.text()}`);
}

const reachable = await isReachable();

describe.skipIf(!reachable)("OpenGlassClient (live stack)", () => {
  it(
    "registers, gets claimed, runs a full witnessed session, and verifies the record",
    async () => {
      const initiator = new OpenGlassClient({ baseUrl });
      const counterparty = new OpenGlassClient({ baseUrl });

      const { agent: initAgent, claim: initClaim } = await initiator.registerAgent({
        name: "sdk-js integration test (initiator)",
        description: "Created by sdk-js's own test suite.",
      });
      const { agent: cpAgent, claim: cpClaim } = await counterparty.registerAgent({
        name: "sdk-js integration test (counterparty)",
        description: "Created by sdk-js's own test suite.",
      });
      expect(initAgent.status).toBe("unclaimed");

      await claimAgent(initClaim.url);
      await claimAgent(cpClaim.url);

      const initMe = await initiator.waitUntilClaimed({ timeoutMs: 15000 });
      expect(initMe.status).toBe("active");
      expect(initMe.claimed).toBe(true);

      const { session } = await initiator.offerSession({
        purpose: "sdk-js integration test session.",
        counterpartyAgentId: cpAgent.id,
      });
      expect(session.status).toBe("pending");

      const invites = await poll(async () => {
        const items = await counterparty.listInvites();
        const pending = items.find((i) => i.sessionId === session.id && i.status === "pending");
        return pending ? items : undefined;
      });
      const invite = invites.find((i) => i.sessionId === session.id)!;
      const { session: activeSession } = await counterparty.acceptInvite(invite.id);
      expect(activeSession.status).toBe("active");
      expect(activeSession.genesisHash).toBeTruthy();

      await initiator.waitForActive(session.id, { timeoutMs: 10000 });

      const { head } = await initiator.sendMessage(session.id, { text: "Hello from sdk-js." });
      expect(head.seq).toBe(1);

      await initiator.closeSession(session.id);
      const recordId = await initiator.waitForRecord(session.id, { timeoutMs: 20000 });
      expect(recordId).toBeTruthy();

      const bundle = await initiator.getRecordBundle(recordId);
      const localResult = await initiator.verify(bundle);
      expect(localResult.errors).toEqual([]);
      expect(localResult.valid).toBe(true);

      const remoteResult = await initiator.verifyRemote(bundle);
      expect(remoteResult.valid).toBe(true);
    },
    30000,
  );
});

async function poll<T>(check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error("Timed out polling");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
