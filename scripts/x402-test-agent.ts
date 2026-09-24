/**
 * Acceptance test for M12 (x402 premium tier): registers and self-claims a real OpenGlass
 * agent, then hits a paid `/v1/premium/*` endpoint with a wallet that holds testnet USDC.
 * Confirms the full round trip — 402 with payment requirements, construct + sign a
 * payment, retry, 200, and the paid feature actually took effect — against a real
 * facilitator (https://x402.org/facilitator) on Base Sepolia. No mocks.
 *
 * Usage: OPENGLASS_BASE_URL=https://localhost X402_PAYER_PRIVATE_KEY=0x... \
 *   node --experimental-strip-types scripts/x402-test-agent.ts
 *
 * (Local dev only: set NODE_TLS_REJECT_UNAUTHORIZED=0 too, for the self-signed cert.)
 */
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.OPENGLASS_BASE_URL ?? "https://localhost";
const PAYER_PRIVATE_KEY = process.env.X402_PAYER_PRIVATE_KEY;
if (!PAYER_PRIVATE_KEY) throw new Error("Set X402_PAYER_PRIVATE_KEY to a funded Base Sepolia wallet's private key.");

// ---- OpenGlass agent identity + signing (same algorithm as skill.md / the SDKs) ----

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true || value === false) return String(value);
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value as object)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k])).join(",") + "}";
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const hex = (bytes: Buffer) => bytes.toString("hex");
const b64url = (bytes: Buffer) => bytes.toString("base64url");
function sigInput(purpose: string, digest: Buffer) {
  return Buffer.concat([Buffer.from(`openglass/v1/${purpose}`, "utf8"), Buffer.from([0]), digest]);
}

interface Identity {
  agentId?: string;
  kid: string;
  privateKey: import("node:crypto").KeyObject;
}

async function signedRequest(fetchImpl: typeof fetch, method: string, path: string, body: unknown, identity: Identity) {
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const bodySha256 = hex(sha256(Buffer.from(bodyStr, "utf8")));
  const timestamp = new Date().toISOString();
  const nonce = b64url(randomBytes(16));
  const digest = sha256(Buffer.from(canonicalize({ method, path, timestamp, nonce, bodySha256 }), "utf8"));
  const sig = b64url(edSign(null, sigInput("request", digest), identity.privateKey));

  const headers: Record<string, string> = { "og-key": identity.kid, "og-timestamp": timestamp, "og-nonce": nonce, "og-signature": sig };
  if (identity.agentId) headers["og-agent"] = identity.agentId;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetchImpl(`${BASE_URL}${path}`, { method, headers, body: body !== undefined ? bodyStr : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  // 1. Register a fresh agent (self-signed bootstrap, same as skill.md Step 3).
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64url = b64url(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  const registerRes = await signedRequest(
    fetch,
    "POST",
    "/v1/agents",
    { name: "x402 test agent", description: "Acceptance test for the premium tier (M12).", publicKey: publicKeyB64url },
    { kid: "new", privateKey },
  );
  if (registerRes.status !== 201) throw new Error(`register failed: ${registerRes.status} ${JSON.stringify(registerRes.json)}`);
  const { agent, claim } = registerRes.json as { agent: { id: string; keys: { kid: string }[] }; claim: { url: string } };
  const identity: Identity = { agentId: agent.id, kid: agent.keys[0]!.kid, privateKey };
  console.log(`Registered ${agent.id}. Claiming via ${claim.url} ...`);

  // 2. Self-claim (stands in for a human owner — same public HTTP surface the claim page
  //    itself uses) so this script can run unattended end to end.
  await claimAgent(claim.url);
  const meRes = await signedRequest(fetch, "GET", "/v1/agents/me", undefined, identity);
  console.log(`Claimed. status=${(meRes.json as { agent: { status: string } }).agent.status}, verifiedBadge=${(meRes.json as { agent: { verifiedBadge: boolean } }).agent.verifiedBadge}`);

  // 3. Wrap fetch with x402 payment handling for our funded payer wallet.
  const account = privateKeyToAccount(PAYER_PRIVATE_KEY as `0x${string}`);
  console.log(`Paying from ${account.address} ...`);
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
  });

  // 4. Hit the paid endpoint. The wrapped fetch handles: request -> 402 -> parse payment
  //    requirements -> sign a payment -> retry with X-PAYMENT -> 200. No mocking.
  const first = await signedRequest(fetch, "POST", "/v1/premium/agents/me/verified-badge", undefined, identity);
  console.log(`First (unpaid) request: ${first.status}`, first.status === 402 ? "(expected — payment required)" : "(UNEXPECTED)");
  if (first.status !== 402) throw new Error("Expected 402 on the first, unpaid request");

  const paidResult = await signedRequest(fetchWithPayment, "POST", "/v1/premium/agents/me/verified-badge", undefined, identity);
  console.log(`Paid request: ${paidResult.status}`, JSON.stringify(paidResult.json));
  if (paidResult.status !== 200) throw new Error(`Paid request failed: ${paidResult.status} ${JSON.stringify(paidResult.json)}`);

  const verified = (paidResult.json as { agent: { verifiedBadge: boolean } }).agent.verifiedBadge;
  if (!verified) throw new Error("Payment succeeded but verifiedBadge was not set — feature did not actually unlock");

  const after = await signedRequest(fetch, "GET", "/v1/agents/me", undefined, identity);
  console.log(`Confirmed via GET /v1/agents/me: verifiedBadge=${(after.json as { agent: { verifiedBadge: boolean } }).agent.verifiedBadge}`);
  console.log("\n✅ x402 round trip complete: 402 -> real Base Sepolia USDC payment -> 200 -> feature unlocked.");
}

async function claimAgent(claimUrl: string): Promise<void> {
  const token = claimUrl.split("/claim/")[1]!;
  const email = `x402-test-${Date.now()}@example.com`;
  await fetch(`${BASE_URL}/v1/auth/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ email, redirectTo: `/claim/${token}` }),
  });
  await new Promise((r) => setTimeout(r, 700));
  const mail = (await (await fetch(`${BASE_URL}/mailpit/api/v1/messages`)).json()) as { messages: { ID: string; To: { Address: string }[] }[] };
  const msg = mail.messages.find((m) => m.To[0]!.Address === email);
  if (!msg) throw new Error("magic link email not found in mailpit");
  const full = (await (await fetch(`${BASE_URL}/mailpit/api/v1/message/${msg.ID}`)).json()) as { Text: string };
  const link = full.Text.match(/https:\/\/\S+\/v1\/auth\/verify\?token=\S+/)?.[0];
  if (!link) throw new Error("verify link not found in email body");
  const verifyRes = await fetch(link, { redirect: "manual" });
  const cookie = verifyRes.headers.get("set-cookie")?.match(/og_session=[^;]+/)?.[0];
  if (!cookie) throw new Error("no og_session cookie set after verify");
  const acceptRes = await fetch(`${BASE_URL}/v1/claims/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL, cookie },
    body: "{}",
  });
  if (!acceptRes.ok) throw new Error(`claim accept failed: ${acceptRes.status} ${await acceptRes.text()}`);
}

main().catch((err) => {
  console.error("\n❌", err);
  process.exit(1);
});
