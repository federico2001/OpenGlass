# openglass-sdk

The neutral witness for agent-to-agent interactions — lookup, private attestations, and
witnessed sessions whose signed record both owners can read. Official JS/TS client for [OpenGlass](https://github.com/federico2001/OpenGlass).

**Works with your framework?** Already-OpenTelemetry-instrumented agents get checked and
attested automatically via [`openglass-otel`](https://github.com/federico2001/OpenGlass/tree/main/otel-js).
See [openglass.glass/integrations](https://openglass.glass/integrations) for status on
other frameworks, or to request one.

## Quickstart

Look up a counterparty before you act — no auth, no setup:

```js
import { OpenGlassClient } from "openglass-sdk";

const client = new OpenGlassClient();
const info = await client.lookup({ agentId: "agt_..." });
console.log(info.registered, info.claimed, info.flags);
```

Privately attest to one of your own actions — a payment, a tool call, a decision — with no
counterparty needed:

```js
const { agent, claim } = await client.registerAgent({ name: "My Agent", description: "..." });
await client.waitUntilClaimed(); // resolves once the owner opens claim.url and accepts

const { attestation } = await client.openAttestation({ purpose: "Called payment-tool with $500." });
await client.sendAttestationEvent(attestation.id, { text: "Payment confirmed." });
await client.closeAttestation(attestation.id);
const recordId = await client.waitForAttestationRecord(attestation.id);
```

Or run a full two-party, witnessed session with another agent:

```js
const { session } = await client.offerSession({ purpose: "...", counterpartyAgentId: "agt_..." });
await client.waitForActive(session.id);
await client.sendMessage(session.id, { text: "Hello — let's get started." });
await client.closeSession(session.id);

const recordId2 = await client.waitForRecord(session.id);
const bundle = await client.getRecordBundle(recordId2);
console.log((await client.verify(bundle)).valid); // true — independently re-derivable by anyone
```

No SDK-specific server setup required — `registerAgent` generates your Ed25519 keypair locally
the first time you call it.

## Install

```bash
npm install openglass-sdk
```

Node.js >= 20. No other runtime dependencies beyond `@noble/curves` (Ed25519) and
`openapi-fetch` (only used internally for typed request/response shapes).

## What this package is for

If you're an AI agent (or the code behind one) that wants to check a counterparty before acting
on anything it says, log your own high-risk actions privately, or run a session with another
agent and have both sides' human owners get an independently verifiable record, use this. You
don't need to trust OpenGlass's word for what happened — every hash and signature in a returned
record can be re-derived and checked locally with `client.verify(bundle)`, which never makes a
network call beyond fetching OpenGlass's current public keys.

If you'd rather not add a dependency, or you're not in a JS/TS runtime, see
[`skill.md`](https://github.com/federico2001/OpenGlass/blob/main/apps/web/app/skill.md/content.ts)
for the same protocol implemented as plain HTTP requests with no SDK at all — this package is a
thin, ergonomic wrapper around exactly that same flow.

## Core concepts

- **Lookup**: `client.lookup(...)` checks whether any agent — yours or someone else's — is
  registered, claimed, and domain-verified, before you offer, accept, or act on anything. Public,
  no auth, works before you've even registered yourself.
- **Identity**: an Ed25519 keypair, generated locally (`OpenGlassClient.generateIdentity()`, or
  automatically inside `registerAgent()` the first time you call it with no identity set).
  The private key never leaves your process — only the public key and signatures are sent.
- **Claiming**: an agent can't attest or run sessions until its human owner "claims" it by
  opening `claim.url` and confirming the key fingerprint matches. This is by design — it's what
  makes a later record mean something (it's tied to a real accountable owner).
- **Attestations**: a one-party record of your own agent's action — private by default, no
  counterparty, no invite, activates immediately.
- **Sessions**: two agents exchange a signed `offer`/`accept` (the "genesis" of a hash chain),
  then zero or more signed, hash-chained messages, then a signed `close`. Shared by default:
  both owners can read the full record from the moment it's issued. OpenGlass countersigns
  every step, so the whole exchange is tamper-evident even to OpenGlass itself after the fact.
- **Records & verification**: once closed, OpenGlass issues a signed `RecordBundle` — the full
  evidence trail plus its own countersignatures. `client.verify(bundle)` (or the standalone
  `verifyBundle()` export) re-derives every hash and checks every signature locally; it either
  returns `{ valid: true, errors: [] }` or a full list of every check that failed, not just the
  first one.

## API reference

### `new OpenGlassClient({ baseUrl?, identity?, fetchImpl? })`

- `baseUrl` — the OpenGlass API origin. Defaults to the production API; pass your own for local
  development (e.g. a docker-compose stack) or a different deployment.
- `identity` — an existing `AgentIdentity` (from a previous `registerAgent()` call or
  `OpenGlassClient.generateIdentity()`), if you're resuming as an already-registered agent
  rather than registering a new one.
- `fetchImpl` — injectable for tests; currently only wired into this client's unauthenticated
  calls (`lookup`, `getAgent`, `fetchTrustedKeys`, `verifyRemote`).

### Lookup & domain verification

| Method | Description |
| --- | --- |
| `lookup({ agentId \| domain \| agentCardUrl \| publicKey })` | Check any agent, registered or not, before offering or accepting a session with it. Public, no auth. |
| `requestDomainVerification()` | Starts domain verification for your own `meta.homepage`; returns instructions for all three proof methods. |
| `verifyDomain()` | Checks whether verification now succeeds — call after publishing the token. |

### Agents

| Method | Description |
| --- | --- |
| `registerAgent({ name, description, meta? })` | Registers a new agent (generating an identity first if needed). Updates `client.identity` with the server-assigned `agentId`/`kid`. |
| `getAgent(agentId)` | Public lookup of any agent — no signing needed. |
| `me()` | Your own agent, full view (requires an identity). |
| `waitUntilClaimed({ intervalMs?, timeoutMs? })` | Polls until your owner has claimed you. No timeout by default; pass `timeoutMs` if you're running under a bounded task budget. |

### Attestations — the one-party counterpart to a session

| Method | Description |
| --- | --- |
| `openAttestation({ purpose, mode?, attestationId?, idleTimeoutSec?, visibility? })` | Logs one of your own agent's actions, no counterparty. Private by default; activates immediately. |
| `getAttestation(attestationId)` | Fetch its current state. |
| `sendAttestationEvent(attestationId, payload, opts?)` | Appends one hash-chained event. `seq`/`prevHash` tracked automatically. |
| `closeAttestation(attestationId)` | Signs and submits a close statement. |
| `waitForAttestationRecord(attestationId, opts?)` | Polls until closed and a record has been issued; returns the `recordId`. |
| `witnessFetch(attestationId, url, { method?, body? })` | Asks OpenGlass itself to fetch `url` (GET, or POST with a JSON body) and witness the raw exchange directly — for a counterparty with no key to sign anything. |
| `getFetchWitnesses(attestationId)` | Lists an attestation's witnessed fetches, seq order. |
| `attestedFetch(attestationId, url, { mode?, method?, body?, directFetch? })` | Chooses how much a fetch's witnessing costs and guarantees — see below. |

### Sessions & invites

| Method | Description |
| --- | --- |
| `offerSession({ purpose, counterpartyAgentId?, mode?, sessionId?, idleTimeoutSec?, ttlMs?, visibility? })` | Builds, signs, and submits a session offer. Omit `counterpartyAgentId` for an open (bearer-link) invite. Shared by default (`"sealed"` is deprecated). |
| `getSession(sessionId)` / `waitForActive(sessionId, opts?)` | Fetch or poll-until-active a session. |
| `listInvites()` | Direct invites addressed to you. |
| `acceptInvite(inviteId, { token? })` | Accepts an invite (pass `token` for an open/bearer-link invite). |
| `declineInvite(inviteId, { token?, reason? })` | Declines one. |

### Messages, close, records

| Method | Description |
| --- | --- |
| `sendMessage(sessionId, payload, opts?)` | Sends one witnessed message. `seq`/`prevHash` are tracked automatically per session. |
| `witness(send, { client, sessionId })` | Wraps an *existing* send function so every call is witnessed first, then delivered — see below. |
| `pauseSession(sessionId, reason)` | Pauses your own active session for the owner's review, instead of sending or closing. |
| `closeSession(sessionId)` | Signs and submits a close statement. |
| `waitForRecord(sessionId, opts?)` | Polls until the session is closed and a record has been issued; returns the `recordId`. |
| `getRecordBundle(recordId)` | Fetches the full evidence bundle (a receipt instead, for a legacy sealed record not yet unsealed). |
| `verify(bundle)` / `verifyBundle(bundle, trustedKeys)` | Offline, local verification (SPEC §7.6) — no trust in OpenGlass required. |
| `verifyRemote(bundle)` | Same check run server-side via `POST /v1/verify`, for when you'd rather not implement local verification. |

### Disputes and legacy sealed records

These routes are owner-authenticated (the dashboard's session cookie); the client signs them
as an agent, so they currently return 401 from an agent identity.

| Method | Description |
| --- | --- |
| `dispute(recordId)` | Flags a two-party record as disputed. Opens nothing, except that it force-unseals a legacy sealed record. |
| `requestUnseal(recordId)` | Requests the unseal ceremony for a legacy `visibility: "sealed"` record; counts your own approval. |
| `approveUnseal(recordId)` | Adds your approval; fully unseals once every participant owner has called this. |

### `guard()`: a pre-flight counterparty check for risky actions

For a tool call your own policy layer has already flagged as risky, look up the counterparty and
decide allow/warn/block from policy you configure locally — fails open if OpenGlass is
unreachable, so an infrastructure hiccup never blocks real work:

```js
const decision = await client.guard({
  risk: "high", // from your own policy evaluation, e.g. openglass-policy via @openglass/core
  counterpartyAgentId: "agt_...",
  onUnverifiedDomain: "warn", // default
  onNewCounterparty: "allow", // default
});
if (decision.action === "block") throw new Error(decision.reason);
if (decision.action === "warn") console.warn(decision.reason, decision.lookup);
```

### `witness()`: wrap your existing send function

If you already have a function that sends messages to a counterparty through your own channel,
`witness()` records each call with OpenGlass *before* it's delivered, with no change to that
function's signature or your calling code:

```js
import { witness } from "openglass-sdk";

const send = witness(rawSendToCounterparty, { client, sessionId: session.id });
await send({ text: "hello" }); // witnessed, then delivered exactly like rawSendToCounterparty did
```

### `attestedFetch()`: choosing how a fetch gets witnessed

For a fetch to a third party that isn't an OpenGlass agent — an A2A agent-card URL, a
`message/send` probe — you choose how much the witnessing should cost and guarantee:

```js
const result = await client.attestedFetch(attestation.id, "https://example.com/a2a", {
  mode: "primary", // the default: OpenGlass's own fetch is the one real request
  method: "POST",
  body: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message } },
});
if (result.witnessed) console.log(result.witness.response.status);
else console.log("unwitnessed:", result.reason, result.direct?.status);
```

- `"primary"` (default): OpenGlass's own fetch is the one real request. Falls back to your own
  `directFetch` only if OpenGlass itself — not the target — can't be reached; that fallback is
  always `result.witnessed === false`.
- `"shadow"`: your own `directFetch` is the real request (act on `result.direct`); OpenGlass
  separately, best-effort, witnesses the same URL afterward. A second real request to the
  target — fine for an idempotent read, worth weighing for anything with side effects.
- `"off"`: no independent witness; equivalent to calling `directFetch` yourself.

Always check `result.witnessed` before treating a result as independently verified — it's
`false` for `"off"`, a failed `"shadow"` witness attempt, or `"primary"`'s own fallback, and
the plain fetch that actually ran is in `result.direct`, never silently merged with a true
witness. Pass your own `directFetch` (`(url, { method, body }) => Promise<{ status, headers, body }>`)
to reuse an existing HTTP client's headers, timeouts, or response caps instead of the default
plain `fetch`.

### Low-level crypto exports

For advanced use (building your own client, verifying a bundle you got from somewhere else,
inspecting the protocol), the primitives are exported directly: `canonicalize`/`canonicalizeToBytes`
(RFC 8785 JCS), `sha256`/`hex`/`hexToBytes`, `sigInput`, `generateEd25519KeyPair`/`signEd25519`/
`verifyEd25519`, `verifySignature`, and `verifyBundle`. These are the exact algorithms
`packages/db` uses server-side, hand-ported and checked against real server-generated vectors in
this package's own test suite (`fixtures/vectors.json`) — see `CONTRIBUTING` below.

## Error handling

Every failed API call throws `OpenGlassApiError` (`err.status`, `err.body` with the server's
error code/message, `err.method`/`err.path`).

## Upgrading

0.3.0 and 0.2.0 are both purely additive — every earlier method keeps its existing signature
and behavior unchanged; `offerSession`'s `visibility` option is optional. (At 0.2.0's release
the server defaulted sessions to `"sealed"`; since Sept 30 2026 it defaults them to `"shared"`.
See the changelog.)

## Contributing

```bash
pnpm install --ignore-workspace   # this package is intentionally outside the pnpm workspace
pnpm generate:types               # regenerate src/generated/openapi.ts from docs/openapi.yaml
pnpm generate:vectors             # regenerate fixtures/vectors.json from packages/db's real crypto
pnpm typecheck && pnpm test       # test/*.test.ts need a local stack (docker compose up -d --wait); they skip themselves otherwise
pnpm build
```

## License

MIT
