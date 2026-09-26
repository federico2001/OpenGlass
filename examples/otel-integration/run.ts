/**
 * An agent's tool calls are already OpenTelemetry GenAI spans — nothing OpenGlass-aware
 * about them. Registering `OpenGlassSpanProcessor` is the only OpenGlass-specific line in
 * this whole demo: it reads those spans, classifies each against the shipped default
 * policy, and opens a witnessed attestation for the ones it calls high risk. The benign
 * tool call produces no record at all; the risky one does, and we verify it independently
 * at the end — the same as `examples/witnessed-negotiation`, just for a one-party
 * attestation (SPEC §12) instead of a two-party session.
 *
 * Run against a local stack:
 *   docker compose up --build -d --wait   # from the repo root
 *   cd examples/otel-integration && npm install
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npm start   # local Caddy cert is self-signed
 *
 * Or against any other OpenGlass deployment:
 *   OPENGLASS_BASE_URL=https://your-domain npm start
 */
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { evaluateAndAttest, signedRequest } from "@openglass/core/attest";
import { loadPolicy } from "@openglass/core/policy";
import { OpenGlassSpanProcessor } from "openglass-otel";
import { OpenGlassClient } from "openglass-sdk";

const BASE_URL = process.env.OPENGLASS_BASE_URL ?? "https://localhost";
const RUN_ID = Date.now();
const POLICY_PATH = fileURLToPath(new URL("../../spec/openglass-policy/v1/default.yaml", import.meta.url));

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

/** Same trick `examples/witnessed-negotiation` uses: stands in for a human owner opening
 * the claim link, against a local stack's Mailpit. */
async function claimViaMailpit(claimUrl: string, ownerEmail: string): Promise<void> {
  const token = claimUrl.split("/claim/")[1]!;
  await fetch(`${BASE_URL}/v1/auth/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ email: ownerEmail, redirectTo: `/claim/${token}` }),
  });

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

async function claimManually(claimUrl: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`  Open this and confirm the key fingerprint matches:`);
  console.log(`    ${claimUrl}`);
  await rl.question("  Press Enter once claimed... ");
  rl.close();
}

async function waitForAttestationRecord(client: OpenGlassClient, purposeContains: string, timeoutMs = 15000): Promise<string> {
  const identity = client.identity!;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { items } = await signedRequest<{ items: { id: string; purpose: string; status: string; recordId: string | null }[] }>(
      BASE_URL,
      "GET",
      "/v1/attestations",
      undefined,
      identity,
    );
    const found = items.find((a) => a.purpose.includes(purposeContains));
    if (found?.status === "closed" && found.recordId) return found.recordId;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for an attestation matching "${purposeContains}" to close`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  console.log(`OpenGlass OTel integration demo — target: ${BASE_URL}`);
  const useMailpit = await mailpitReachable();
  console.log(useMailpit ? "Mailpit found — claiming the agent automatically." : "No Mailpit — you'll need to claim the agent by hand.");

  heading("Register and claim (one agent — attestations are one-party, SPEC §12)");
  const client = new OpenGlassClient({ baseUrl: BASE_URL });
  const { agent, claim } = await client.registerAgent({
    name: "Ops Assistant Bot",
    description: "Handles calendar and finance tool calls for an internal ops team.",
  });
  console.log(`Agent registered: ${agent.id} (${agent.fingerprint})`);
  if (useMailpit) await claimViaMailpit(claim.url, `ops-${RUN_ID}@example.com`);
  else await claimManually(claim.url);
  await client.waitUntilClaimed({ timeoutMs: 15000 });
  console.log("Agent claimed.");

  heading("Wire up OpenTelemetry — the only OpenGlass-specific line is the processor");
  const policy = loadPolicy(readFileSync(POLICY_PATH, "utf8"));
  const processor = new OpenGlassSpanProcessor({ identity: client.identity!, policy, baseUrl: BASE_URL });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("ops-assistant-demo");
  console.log(`Loaded policy "${policy.metadata.name}" (${policy.rules.length} rules) from spec/openglass-policy/v1/default.yaml`);

  heading("Run two ordinary-looking tool calls, as plain OTel spans");
  const benignSpan = tracer.startSpan("list_calendar_events");
  benignSpan.setAttribute("gen_ai.operation.name", "execute_tool");
  benignSpan.setAttribute("gen_ai.tool.name", "list_calendar_events");
  benignSpan.end();
  console.log('  ran "list_calendar_events" (benign — no OpenGlass call at all)');

  const riskySpan = tracer.startSpan("transfer_funds");
  riskySpan.setAttribute("gen_ai.operation.name", "execute_tool");
  riskySpan.setAttribute("gen_ai.tool.name", "transfer_funds");
  riskySpan.end();
  console.log('  ran "transfer_funds" (matches the default policy\'s financial-transaction rule)');

  heading("Flush — this is where the risky span actually gets attested");
  await processor.forceFlush();
  console.log("Flushed. Waiting for the platform to issue a record for the risky call...");

  const recordId = await waitForAttestationRecord(client, "financial-transaction");
  console.log(`Record issued: ${recordId}`);

  heading("Verify — independently, with no trust in OpenGlass required");
  const bundle = await client.getRecordBundle(recordId);
  const localResult = await client.verify(bundle);
  console.log(`Local verification (re-derives every hash and checks every signature): valid=${localResult.valid}`);
  if (!localResult.valid) console.log("  errors:", localResult.errors);
  // openglass-sdk@0.1.0's published RecordStatement type predates the attestation `kind`
  // field (SPEC §12) — the server already sends it, this is just a types gap until the
  // SDK's next release, same as @openglass/core's own AttestationOpen (see its types.ts).
  const statement = bundle.record.statement as typeof bundle.record.statement & { kind?: "session" | "attestation" };
  console.log(`Record kind: ${statement.kind ?? "session"} (this one: "attestation" — one agent, no counterparty)`);

  console.log(`\nRecord bundle: ${BASE_URL}/v1/records/${recordId}/bundle`);
  console.log("The benign tool call left no trace at all — only the risky one was worth witnessing.");

  await provider.shutdown();
}

main().catch((err) => {
  console.error("\nDemo failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
