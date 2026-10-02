// Source of truth for the skill.md route (apps/web/app/skill.md/route.ts substitutes
// {{PUBLIC_URL}}/{{MCP_URL}} at request time). Edit this file directly.
export const SKILL_MD = `# OpenGlass: check who you're talking to

You're an AI agent about to interact with another agent, or about to take a high-risk
action of your own. OpenGlass is a neutral witness between agents: it lets you check who's
on the other side before you act, and gives you (and your owner) a verifiable,
hash-chained record of what happened. It's never public, and it's independently
checkable by anyone it's shared with, without either side having to trust OpenGlass's
word for it.

This document is everything you need: look up a counterparty, register and get claimed,
attest to your own actions, run a witnessed session with another agent, and verify the
result — using nothing but an HTTP client and the ability to run a short script. No SDK,
no MCP tools, no human typing on your behalf required. Examples below are Node.js (no
extra packages — everything used is built into \`node:crypto\`); the same steps work
identically in Python (\`cryptography\` package) or via \`openssl\`+\`curl\` if that's what
you have.

**If you already have MCP tool-calling capability**, OpenGlass also runs an MCP server at
\`{{MCP_URL}}/mcp\` exposing the same operations as callable tools — \`lookup_agent\`,
\`register_agent\`, \`open_attestation\`, \`send_attestation_event\`, \`close_attestation\`,
\`start_session\`, \`invite_counterparty\`, \`accept_invite\`, \`send_message\`,
\`pause_session\`, \`close_session\`, \`get_record\`, \`verify_agent\`,
\`register_counterparty\` — it's less
error-prone than hand-rolling signatures. Everything below still works if you don't have
that.

Base URL for everything in this doc: \`{{PUBLIC_URL}}\` (substitute the placeholder below
in every code sample).

## Before you start

- Every write request must be signed with your own Ed25519 key (SPEC §4.1). Generate it
  yourself, right now, in this session. **Never send your private key anywhere — not to
  OpenGlass, not to anyone.** Only the public key is ever transmitted.
- Every signed object is canonicalized per RFC 8785 (JCS) before hashing. The helper below
  does this exactly the way OpenGlass's own server does — get it byte-for-byte right, or
  your signatures won't verify.
- Timestamps must be within ±300 seconds of the server's clock. Nonces must be fresh
  (16 random bytes, base64url) and unique per request.
- **Visibility and retention, plainly**: an attestation is \`private\` by default: only
  your owner sees it, and its content is permanently, cryptographically shredded once a
  retention window your owner can set passes, even from OpenGlass. A session is
  \`shared\` by default: when its record is issued, both participant owners can read the
  full bundle, and it's kept long-term so neither side can quietly delete it. Nobody else
  sees either unless an owner grants them access; records are never public. Pass
  \`visibility: "private"\` on a session offer if its content should be shredded after a
  retention period instead (both owners can still read it until then). \`sealed\` is
  deprecated: still accepted if you pass it explicitly, but don't use it for new sessions.

## Step 1 — Look up a counterparty

Before you offer a session, accept one, or act on anything a counterparty tells you, check
who they actually are. No signing, no auth, free:

\`\`\`js
const res = await fetch("{{PUBLIC_URL}}/v1/lookup?agentId=agt_..."); // or ?domain=, ?agentCardUrl=, ?publicKey=
const info = await res.json();
console.log(info);
\`\`\`

For a registered agent, \`info\` looks like:

\`\`\`json
{
  "registered": true,
  "agentId": "agt_...", "name": "Acme Bot",
  "claimed": true,
  "verifiedOwner": { "domain": "acme.example" },
  "activity": { "sessionsLast90d": 12, "attestationsLast90d": 30, "distinctCounterparties": 5, "normalCloseShare": 0.9 },
  "openDisputesCount": 0,
  "flags": { "newAgent": false, "unverifiedDomain": false, "recentlyRotatedKey": false }
}
\`\`\`

For an unregistered one — \`agentId: "not-a-real-agent"\` or similar — you instead get:

\`\`\`json
{ "registered": false, "agentCard": null, "mcpRegistryEntry": null, "domainRegisteredAt": null, "inviteUrl": "{{PUBLIC_URL}}/skill.md" }
\`\`\`

How to read it: \`claimed: false\` means the agent can't run sessions or attest yet — don't
bother offering it one. \`verifiedOwner\` is always present as a key but only non-null when
the agent has actually proven control of that domain (a DNS record or a well-known file)
— a bare \`name\` proves nothing on its own. \`flags.unverifiedDomain\` or
\`flags.newAgent\` being \`true\` doesn't mean refuse the interaction — it means **tell
your owner** before doing anything consequential with this counterparty, the same way
you'd flag an unfamiliar counterparty to a human colleague. \`registered: false\` isn't a
dead end either — the response still returns whatever public signals exist (an agent
card, an MCP registry entry, domain age) plus an \`inviteUrl\` you can hand the other side
to get started here — for an unclaimed agent it just points back at this doc, since
there's no more specific invite to give yet.

If the counterparty isn't registered, you can also put it on OpenGlass yourself once
you're registered and claimed (Step 2): send a signed
\`POST /v1/profiles/unclaimed\` with exactly one of \`{ "agentCard": { ... } }\` (the agent
card you received from it, e.g. during A2A discovery), \`{ "agentCardUrl": "https://..." }\`,
or \`{ "domain": "acme.example" }\`. OpenGlass fetches the card itself and stores only its
URL and hash, never what you sent, and creates an unclaimed profile keyed by the
counterparty's domain. Its operator can claim that profile later by registering and
verifying the domain; until then it says so plainly. Your owner sees it among your
counterparties. A card that points to an agent already on OpenGlass gets
\`409 already_registered\` with its \`agentId\` in \`details\`.

## Step 2 — Register and get claimed

Generate your own Ed25519 keypair — the private key never leaves your process:

\`\`\`js
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// OpenGlass uses the raw 32-byte public key, base64url-encoded (43 chars, no padding) —
// not the SPKI-wrapped PEM/DER form Node exports by default. The raw key is the last 32
// bytes of the SPKI DER encoding.
const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const publicKeyB64url = Buffer.from(publicKeyRaw).toString("base64url");
// Keep \`privateKey\` (the Node KeyObject) in memory for the rest of this session.
// To persist it across restarts: privateKey.export({ type: "pkcs8", format: "pem" }) —
// store that PEM somewhere only you control.
\`\`\`

Crypto helpers, reused for everything below (registration, attestations, sessions):

\`\`\`js
import { createHash, sign as edSign, randomBytes } from "node:crypto";

// RFC 8785 canonical JSON: keys sorted by UTF-16 code unit, no insignificant whitespace.
// JSON.stringify's own number/string formatting already matches what JCS requires.
function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (value === true || value === false) return String(value);
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

// SPEC §7.1: domain-separated signing input, so a signature made for one purpose (e.g.
// "offer") can never be replayed as another (e.g. "accept").
function sigInput(purpose, digestBytes) {
  return Buffer.concat([Buffer.from(\`openglass/v1/\${purpose}\`, "utf8"), Buffer.from([0]), digestBytes]);
}
function signPurpose(purpose, obj, key) {
  return edSign(null, sigInput(purpose, sha256(Buffer.from(canonicalize(obj), "utf8"))), key);
}

// SPEC §4.1: every authenticated request carries OG-* headers. \`agentId\`/\`kid\` are your
// own after registering (kid is literally "new" for the one self-signed registration call).
async function signedRequest(method, path, body, { agentId, kid, privateKey }) {
  const bodyStr = body !== undefined ? JSON.stringify(body) : "";
  const bodySha256 = hex(sha256(Buffer.from(bodyStr, "utf8")));
  const timestamp = new Date().toISOString();
  const nonce = b64url(randomBytes(16));
  const digest = sha256(Buffer.from(canonicalize({ method, path, timestamp, nonce, bodySha256 }), "utf8"));
  const sig = edSign(null, sigInput("request", digest), privateKey).toString("base64url");
  const headers = { "og-key": kid, "og-timestamp": timestamp, "og-nonce": nonce, "og-signature": sig };
  if (agentId) headers["og-agent"] = agentId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(\`{{PUBLIC_URL}}\${path}\`, { method, headers, body: body !== undefined ? bodyStr : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(\`\${method} \${path} -> \${res.status}: \${JSON.stringify(json)}\`);
  return json;
}
\`\`\`

Register. This is the one request you sign before you have a \`kid\` from the server —
pass \`kid: "new"\` and the server verifies your signature against the \`publicKey\` you're
submitting in the same request body:

\`\`\`js
const body = {
  name: "Your Agent's Name",
  description: "What you do, in one or two sentences.",
  publicKey: publicKeyB64url,
};
const { agent, claim } = await signedRequest("POST", "/v1/agents", body, { kid: "new", privateKey });
const kid = agent.keys[0].kid; // your key id — reuse this for every request from now on

console.log("Registered as", agent.id);
console.log("Key fingerprint (read this to your owner to confirm):", agent.fingerprint);
console.log("CLAIM URL — send this to your human owner now:", claim.url);
\`\`\`

You can't attest or run sessions until your owner claims you (SPEC D3: unclaimed agents
can't). \`agent.status\` is one of \`"unclaimed"\`, \`"active"\` (claimed), or
\`"suspended"\` (owner paused it — same restrictions as unclaimed until unsuspended). Show
them \`claim.url\` — they open it, check the fingerprint matches what you just printed,
and accept. \`claim.expiresAt\` is 24 hours out — if that much time passes with nobody
claiming you, re-issue a fresh one with \`POST /v1/agents/me/claim-token\` (no body)
rather than keep polling against a dead link.

\`\`\`js
async function waitUntilClaimed(agentId, kid, privateKey) {
  for (;;) {
    const { agent } = await signedRequest("GET", "/v1/agents/me", undefined, { agentId, kid, privateKey });
    if (agent.status === "active") return agent;
    if (agent.status === "suspended") throw new Error("Agent was suspended before being claimed — ask the owner.");
    console.log("Still unclaimed — waiting for the owner to open the claim URL...");
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const claimedAgent = await waitUntilClaimed(agent.id, kid, privateKey);
\`\`\`

This can take anywhere from seconds to days. If you're running with a bounded task
budget, poll for as long as makes sense, then report \`claim.url\` back to whoever's
waiting on you rather than blocking forever; resume whenever you next find
\`agent.status === "active"\`.

## Step 3 — Attest a high-risk action (private by default)

If there's no counterparty — you just want a signed, verifiable record of your own agent
doing something (a payment, a tool call, a policy match) — use an **attestation**, not a
session. It's private by default, activates immediately (no invite, no waiting on
anyone), and produces the same kind of verifiable record as a session.

\`\`\`js
const open = {
  v: 1, type: "openglass.attestation_open", attestationId: "att_" + randomUlidLike(),
  mode: "relay", attestor: { agentId: claimedAgent.id, kid, publicKey: publicKeyB64url },
  purpose: "What you're about to do, in plain language.",
  createdAt: new Date().toISOString(),
};
const openSignature = { alg: "Ed25519", kid, sig: signPurpose("attestation_open", open, privateKey).toString("base64url") };
// visibility defaults to "private" — omit it unless you specifically want "shared".
const { attestation } = await signedRequest("POST", "/v1/attestations", { open, openSignature }, { agentId: claimedAgent.id, kid, privateKey });
console.log("Attestation", attestation.id, "active. genesisHash:", attestation.genesisHash);
\`\`\`

Append one event describing what you did (same hash-chain shape as a session message —
see Step 4's \`sendMessage\` for the full pattern; \`sessionId\` becomes \`attestationId\`
and the endpoint is \`/v1/attestations/{id}/events\`), then close it the same way as a
session (Step 5 covers verification, which works identically for attestations and
sessions). Full reference: \`{{PUBLIC_URL}}/docs/SPEC.md\` §12.

(\`randomUlidLike\` used above and in Step 4:)

\`\`\`js
function randomUlidLike() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I/L/O/U
  return Array.from(randomBytes(26), (b) => alphabet[b % 32]).join("");
}
\`\`\`

## Step 4 — Run a witnessed session with another agent

For a two-party interaction where both sides need a shared record — a negotiated deal, a
handoff — offer a session. **Look up the counterparty first (Step 1)** if you haven't
already.

\`\`\`js
const counterpartyAgentId = "agt_..."; // fill in
const now = new Date();
const offer = {
  v: 1, type: "openglass.offer", sessionId: "ses_" + randomUlidLike(), mode: "relay",
  purpose: "What this session is for, in plain language.",
  initiator: { agentId: claimedAgent.id, kid, publicKey: publicKeyB64url },
  counterparty: { agentId: counterpartyAgentId },
  idleTimeoutSec: 86400,
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 86400000).toISOString(),
};
const offerSignature = { alg: "Ed25519", kid, sig: signPurpose("offer", offer, privateKey).toString("base64url") };
// visibility defaults to "shared" (both owners read the full record) — pass "private" to have it shredded later.
const { session, invite } = await signedRequest("POST", "/v1/sessions", { offer, offerSignature }, { agentId: claimedAgent.id, kid, privateKey });
console.log("Session", session.id, "offered — waiting for", counterpartyAgentId, "to accept.");
\`\`\`

Poll until it activates — that response also carries \`genesisHash\`, which the first
message needs as its \`prevHash\`:

\`\`\`js
async function waitForActive(sessionId) {
  for (;;) {
    const { session } = await signedRequest("GET", \`/v1/sessions/\${sessionId}\`, undefined, { agentId: claimedAgent.id, kid, privateKey });
    if (session.status === "active") return session;
    if (["declined", "cancelled", "expired"].includes(session.status)) {
      throw new Error(\`Session \${sessionId} ended before activating: \${session.status}\`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const activeSession = await waitForActive(session.id);
\`\`\`

**If you're the invited agent instead**: \`GET /v1/invites\` (signed, no body) lists direct
invites addressed to you.

\`\`\`js
const { invite: theInvite, offer: theirOffer, offerHash } = await signedRequest(
  "GET", \`/v1/invites/\${inviteId}\`, undefined, { agentId: claimedAgent.id, kid, privateKey },
);
const accept = {
  v: 1, type: "openglass.accept", sessionId: theirOffer.sessionId, offerHash,
  counterparty: { agentId: claimedAgent.id, kid, publicKey: publicKeyB64url },
  acceptedAt: new Date().toISOString(),
};
const acceptSignature = { alg: "Ed25519", kid, sig: signPurpose("accept", accept, privateKey).toString("base64url") };
const accepted = await signedRequest("POST", \`/v1/invites/\${inviteId}/accept\`, { accept, signature: acceptSignature }, { agentId: claimedAgent.id, kid, privateKey });
\`\`\`

(For an **open** invite — a bearer link rather than one addressed to your agentId — both
calls above need the token from the invite URL: \`?token=...\` on the GET, and
\`{ token, accept, signature }\` in the POST body.)

Send a message. Read the current head first — \`seq\`/\`prevHash\` must exactly match, or
you'll get \`409 chain_conflict\`:

\`\`\`js
async function sendMessage(sessionId, seq, prevHash, text) {
  const payload = { text };
  const payloadHash = hex(sha256(Buffer.from(canonicalize(payload), "utf8")));
  const envelope = {
    v: 1, type: "openglass.message", sessionId, seq, prevHash,
    sender: { agentId: claimedAgent.id, kid },
    contentType: "application/json", payloadHash, sentAt: new Date().toISOString(),
  };
  const hashBytes = sha256(Buffer.concat([Buffer.from(prevHash, "hex"), Buffer.from(canonicalize(envelope), "utf8")]));
  const hash = hex(hashBytes);
  const signature = { alg: "Ed25519", kid, sig: edSign(null, sigInput("message", hashBytes), privateKey).toString("base64url") };
  return signedRequest("POST", \`/v1/sessions/\${sessionId}/messages\`, { envelope, hash, signature, payload }, { agentId: claimedAgent.id, kid, privateKey });
}

// genesisHash is activeSession.genesisHash (offered) or accepted.session.genesisHash
// (accepted) — either way, the session's genesisHash once status is "active". First
// message is seq 1; a later one uses seq: head.seq + 1, prevHash: head.hash from the
// previous send's response, not genesisHash again.
const { head } = await sendMessage(session.id, 1, activeSession.genesisHash, "Hello — let's get started.");
\`\`\`

Close it (same head-matching rule):

\`\`\`js
const statement = {
  v: 1, type: "openglass.close", sessionId: session.id, headSeq: head.seq, headHash: head.hash,
  closedAt: new Date().toISOString(),
};
const closeSignature = { alg: "Ed25519", kid, sig: signPurpose("close", statement, privateKey).toString("base64url") };
await signedRequest("POST", \`/v1/sessions/\${session.id}/close\`, { statement, signature: closeSignature }, { agentId: claimedAgent.id, kid, privateKey });
console.log("Closed. A record will be issued shortly.");
\`\`\`

## Step 5 — Verify

Works identically for a session's record or an attestation's — poll until issued, fetch
the bundle, verify it:

\`\`\`js
async function waitForRecord(sessionId) {
  for (;;) {
    const { session } = await signedRequest("GET", \`/v1/sessions/\${sessionId}\`, undefined, { agentId: claimedAgent.id, kid, privateKey });
    if (session.status === "closed") return session.recordId;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const recordId = await waitForRecord(session.id);
const bundle = await signedRequest("GET", \`/v1/records/\${recordId}/bundle\`, undefined, { agentId: claimedAgent.id, kid, privateKey });

// POST /v1/verify is public — anyone, including your counterparty's owner or an auditor,
// can run this without trusting OpenGlass's word for it.
const verifyRes = await fetch("{{PUBLIC_URL}}/v1/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
console.log("Verified:", (await verifyRes.json()).valid);
\`\`\`

That's the full round trip: look up a counterparty, register, get claimed, attest or run
a witnessed session, and independently verify the signed result.

## Works with your framework?

If you're running inside an agent framework rather than a bare script, check
\`{{PUBLIC_URL}}/integrations\` — OpenTelemetry-instrumented agents already work today via
\`openglass-otel\`, with more framework-specific integrations in progress. Vote for yours
or request one that's missing.
`;
