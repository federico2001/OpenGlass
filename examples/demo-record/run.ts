/**
 * Records the session shown on /demo. Two agents, clearly named as demo agents, run one
 * short witnessed session; the script verifies the record and writes its bundle to
 * apps/web/public/demo/record.json, which the /demo page loads.
 *
 *   cd examples/demo-record && npm install
 *   OPENGLASS_BASE_URL=https://openglass.glass npm start
 *
 * Claiming stays a human step: the script prints each claim link and waits for you to open
 * it, sign in as the owner and confirm. Run it once; every run registers two new agents.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { OpenGlassClient } from "openglass-sdk";

const BASE_URL = process.env.OPENGLASS_BASE_URL ?? "https://localhost";
const OUT = process.env.DEMO_OUT ?? path.resolve(import.meta.dirname, "../../apps/web/public/demo/record.json");
const LABEL = "Demo agent run by the OpenGlass project for the public /demo page. Not a real business.";

async function claim(url: string, who: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nClaim the ${who}: open this link, sign in, and confirm the fingerprint.\n  ${url}`);
  await rl.question("Press Enter once it's claimed... ");
  rl.close();
}

async function main(): Promise<void> {
  console.log(`Recording the demo session against ${BASE_URL}`);
  const client = new OpenGlassClient({ baseUrl: BASE_URL });
  const provider = new OpenGlassClient({ baseUrl: BASE_URL });

  const { agent: clientAgent, claim: clientClaim } = await client.registerAgent({ name: "Demo Client (demo agent)", description: LABEL });
  const { agent: providerAgent, claim: providerClaim } = await provider.registerAgent({ name: "Demo Provider (demo agent)", description: LABEL });
  console.log(`Registered ${clientAgent.id} and ${providerAgent.id}`);

  await claim(clientClaim.url, "demo client");
  await claim(providerClaim.url, "demo provider");
  await client.waitUntilClaimed({ timeoutMs: 15000 });
  await provider.waitUntilClaimed({ timeoutMs: 15000 });

  const { session } = await client.offerSession({
    purpose: "Demo: agree the scope of a two-week engagement.",
    counterpartyAgentId: providerAgent.id,
  });
  const invite = (await provider.listInvites()).find((i) => i.sessionId === session.id);
  if (!invite) throw new Error("the provider never received the invite");
  await provider.acceptInvite(invite.id);
  await client.waitForActive(session.id, { timeoutMs: 10000 });

  // Each side reads the current head before sending, since the other side moved it.
  async function send(from: OpenGlassClient, text: string): Promise<void> {
    const current = await from.getSession(session.id);
    await from.sendMessage(session.id, { text }, { seq: current.head.seq + 1, prevHash: current.head.hash ?? current.genesisHash! });
    console.log(`  ${text}`);
  }
  await send(client, "We'd like help with a two-week engagement starting November 2. Can you send a proposal?");
  await send(provider, "Proposal: 2 consultants for 10 working days, weekly check-ins, a written summary at the end.");
  await send(client, "That works. Please confirm and we'll treat this as the agreement.");
  await send(provider, "Confirmed: 2 consultants, 10 working days from November 2, weekly check-ins, summary at the end.");

  await provider.closeSession(session.id);
  const recordId = await client.waitForRecord(session.id, { timeoutMs: 60000 });
  const bundle = await client.getRecordBundle(recordId);
  const result = await client.verify(bundle);
  if (!result.valid) throw new Error(`the record didn't verify: ${JSON.stringify(result.errors)}`);

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`\nRecord ${recordId} verified and saved to ${OUT}`);
}

main().catch((err) => {
  console.error("\nRecording failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
