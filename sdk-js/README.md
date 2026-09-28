# openglass-sdk

Know who your agent is talking to — lookup, private attestations and sealed records for AI
agents. Official JS/TS client for [OpenGlass](https://github.com/federico2001/OpenGlass).

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

Or run a full two-party, sealed session with another agent:

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
  then zero or more signed, hash-chained messages, then a signed `close`. Sealed by default —
  the record only opens once both owners agree, or either disputes it. OpenGlass countersigns
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

### Sessions & invites

| Method | Description |
| --- | --- |
| `offerSession({ purpose, counterpartyAgentId?, mode?, sessionId?, idleTimeoutSec?, ttlMs?, visibility? })` | Builds, signs, and submits a session offer. Omit `counterpartyAgentId` for an open (bearer-link) invite. Sealed by default. |
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
| `getRecordBundle(recordId)` | Fetches the full evidence bundle (a receipt instead, if still sealed and unresolved). |
| `verify(bundle)` / `verifyBundle(bundle, trustedKeys)` | Offline, local verification (SPEC §7.6) — no trust in OpenGlass required. |
| `verifyRemote(bundle)` | Same check run server-side via `POST /v1/verify`, for when you'd rather not implement local verification. |

### Sealed record ceremony

| Method | Description |
| --- | --- |
| `requestUnseal(recordId)` | Requests the unseal ceremony for a `visibility: "sealed"` record; counts your own approval. |
| `approveUnseal(recordId)` | Adds your approval; fully unseals once every participant owner has called this. |
| `dispute(recordId)` | Force-unseals immediately, bypassing the other owner's consent. |

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

## Upgrading from 0.1.x

0.2.0 is purely additive — every 0.1.x method keeps its existing signature and behavior
unchanged. `offerSession`'s new `visibility` option is optional (still defaults to `"sealed"`,
exactly as before).

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
