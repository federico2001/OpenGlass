/**
 * Two agents — a buyer and a supplier — negotiate a purchase order entirely through
 * OpenGlass, then independently verify the resulting record. This is the full protocol
 * round trip from `docs/SPEC.md`: register, get claimed by a human owner, offer/accept a
 * session, exchange hash-chained signed messages, close, and verify a record that neither
 * agent (nor OpenGlass itself, after the fact) can alter.
 *
 * Run against a local stack:
 *   docker compose up --build -d --wait   # from the repo root
 *   cd examples/witnessed-negotiation && npm install
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npm start   # local Caddy cert is self-signed
 *
 * Or against any other OpenGlass deployment:
 *   OPENGLASS_BASE_URL=https://your-domain npm start
 *
 * Claiming an agent is normally a human opening a link in a browser — that's the point,
 * it's what ties a later record to a real accountable owner. This script automates that
 * step against a local stack's Mailpit (the docker-compose email catcher), the same way
 * sdk-js's own integration test does. Against anything else, it prints each claim link
 * and waits for you to open it and press Enter.
 */
import { createInterface } from "node:readline/promises";
import { OpenGlassClient } from "openglass-sdk";

const BASE_URL = process.env.OPENGLASS_BASE_URL ?? "https://localhost";
const RUN_ID = Date.now();

function heading(text: string): void {
  console.log(`\n== ${text} ${"=".repeat(Math.max(0, 60 - text.length))}`);
}

async function mailpitReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/mailpit/api/v1/messages`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Stands in for a human owner opening `claimUrl` and confirming the key fingerprint,
 * using the same public HTTP surface the claim page itself uses (SPEC §5.1, §4.2). */
async function claimViaMailpit(claimUrl: string, ownerEmail: string): Promise<void> {
  const token = claimUrl.split("/claim/")[1]!;
  await fetch(`${BASE_URL}/v1/auth/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ email: ownerEmail, redirectTo: `/claim/${token}` }),
  });

  // Mailpit delivers near-instantly locally, but give it a moment.
  let messageId: string | undefined;
  for (let attempt = 0; attempt < 10 && !messageId; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    const mail = (await fetch(`${BASE_URL}/mailpit/api/v1/messages`).then((r) => r.json())) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    messageId = mail.messages.find((m) => m.To[0]?.Address === ownerEmail)?.ID;
  }
  if (!messageId) throw new Error(`magic-link email for ${ownerEmail} never arrived in Mailpit`);

  const full = (await fetch(`${BASE_URL}/mailpit/api/v1/message/${messageId}`).then((r) => r.json())) as { Text: string };
  const verifyLink = full.Text.match(/https?:\/\/\S+\/v1\/auth\/verify\?token=\S+/)?.[0];
  if (!verifyLink) throw new Error("sign-in link not found in the magic-link email body");

  const verifyRes = await fetch(verifyLink, { redirect: "manual" });
  const cookie = verifyRes.headers.get("set-cookie")?.match(/og_session=[^;]+/)?.[0];
  if (!cookie) throw new Error("signing in did not set an og_session cookie");

  const acceptRes = await fetch(`${BASE_URL}/v1/claims/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL, cookie },
    body: "{}",
  });
  if (!acceptRes.ok) throw new Error(`claim accept failed: ${acceptRes.status} ${await acceptRes.text()}`);
}

async function claimManually(claimUrl: string, ownerLabel: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`  Open this as ${ownerLabel} and confirm the key fingerprint matches:`);
  console.log(`    ${claimUrl}`);
  await rl.question("  Press Enter once claimed... ");
  rl.close();
}

async function claimAgent(claimUrl: string, ownerLabel: string, ownerEmail: string, useMailpit: boolean): Promise<void> {
  if (useMailpit) {
    await claimViaMailpit(claimUrl, ownerEmail);
  } else {
    await claimManually(claimUrl, ownerLabel);
  }
}

async function main(): Promise<void> {
  console.log(`OpenGlass witnessed negotiation demo — target: ${BASE_URL}`);
  const useMailpit = await mailpitReachable();
  console.log(useMailpit ? "Mailpit found — claiming both agents automatically." : "No Mailpit — you'll need to claim each agent by hand.");

  heading("Register");
  const buyer = new OpenGlassClient({ baseUrl: BASE_URL });
  const supplier = new OpenGlassClient({ baseUrl: BASE_URL });

  const { agent: buyerAgent, claim: buyerClaim } = await buyer.registerAgent({
    name: "Acme Procurement Bot",
    description: "Buys components for Acme Manufacturing.",
  });
  console.log(`Buyer agent registered: ${buyerAgent.id} (${buyerAgent.fingerprint})`);

  const { agent: supplierAgent, claim: supplierClaim } = await supplier.registerAgent({
    name: "Northwind Supply Bot",
    description: "Handles order fulfillment for Northwind Supply Co.",
  });
  console.log(`Supplier agent registered: ${supplierAgent.id} (${supplierAgent.fingerprint})`);

  heading("Claim (human owners confirm each agent)");
  await claimAgent(buyerClaim.url, "Acme's owner", `buyer-${RUN_ID}@example.com`, useMailpit);
  await claimAgent(supplierClaim.url, "Northwind's owner", `supplier-${RUN_ID}@example.com`, useMailpit);
  const buyerMe = await buyer.waitUntilClaimed({ timeoutMs: 15000 });
  const supplierMe = await supplier.waitUntilClaimed({ timeoutMs: 15000 });
  console.log(`Both agents claimed. Buyer owner: ${buyerMe.ownerId}, supplier owner: ${supplierMe.ownerId}`);

  heading("Offer and accept a session");
  const { session, invite } = await buyer.offerSession({
    purpose: "Negotiate delivery date and quantity for PO 4411 (2,000x M4x12 bolts).",
    counterpartyAgentId: supplierAgent.id,
  });
  console.log(`Session offered: ${session.id} (mode: ${session.mode}, invite: ${invite.id})`);

  const invites = await supplier.listInvites();
  const pendingInvite = invites.find((i) => i.sessionId === session.id)!;
  const { session: activeSession } = await supplier.acceptInvite(pendingInvite.id);
  await buyer.waitForActive(session.id, { timeoutMs: 10000 });
  console.log(`Session active. Genesis hash: ${activeSession.genesisHash}`);

  heading("Negotiate (each message hash-chained and signed as it's sent)");
  // Each side is its own OpenGlassClient, tracking only the head it's personally pushed
  // forward — so before sending, ask the server for the session's actual current head
  // (SPEC §5.3 step 1) rather than trust local state, which the *other* side just moved.
  async function sendWitnessed(from: OpenGlassClient, text: string): Promise<{ seq: number; hash: string }> {
    const current = await from.getSession(session.id);
    const seq = current.head.seq + 1;
    const prevHash = current.head.hash ?? current.genesisHash!;
    const { head } = await from.sendMessage(session.id, { text }, { seq, prevHash });
    return head;
  }

  const exchange: { from: OpenGlassClient; label: string; text: string }[] = [
    { from: buyer, label: "Buyer  ", text: "Requesting 2,000x M4x12 bolts, delivered by 2026-10-15. Can you meet that date?" },
    { from: supplier, label: "Supplier", text: "We can do 2026-10-20 at the quoted price, or 2026-10-15 with a 4% expedite fee." },
    { from: buyer, label: "Buyer  ", text: "2026-10-15 with the expedite fee works. Confirming the order." },
    { from: supplier, label: "Supplier", text: "Confirmed: 2,000x M4x12 bolts, delivery 2026-10-15, expedite fee applied." },
  ];
  let lastSender = buyer;
  for (const { from, label, text } of exchange) {
    const head = await sendWitnessed(from, text);
    console.log(`  [${label}] seq ${head.seq}  hash ${head.hash.slice(0, 12)}…  "${text}"`);
    lastSender = from;
  }

  heading("Close and wait for the record");
  // Whoever sent the final message has the freshest head in hand; either participant may
  // close (SPEC §5.4), but closing from the last sender avoids a needless extra fetch.
  await lastSender.closeSession(session.id);
  const recordId = await buyer.waitForRecord(session.id, { timeoutMs: 30000 });
  console.log(`Record issued: ${recordId}`);

  heading("Verify — independently, with no trust in OpenGlass required");
  const bundle = await buyer.getRecordBundle(recordId);
  const localResult = await buyer.verify(bundle);
  console.log(`Local verification (re-derives every hash and checks every signature): valid=${localResult.valid}`);
  if (!localResult.valid) console.log("  errors:", localResult.errors);

  const remoteResult = await buyer.verifyRemote(bundle);
  console.log(`Server-side verification (POST /v1/verify, same algorithm): valid=${remoteResult.valid}`);

  console.log(`\nRecord bundle: ${BASE_URL}/v1/records/${recordId}/bundle`);
  console.log("Anyone can fetch and re-verify that bundle independently — that's the whole point.");
}

main().catch((err) => {
  console.error("\nDemo failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
