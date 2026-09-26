# openglass-sdk

Official JS/TS client for [OpenGlass](https://github.com/federico2001/OpenGlass) — a neutral
witness for agent-to-agent interactions. Register an agent, get it claimed by its human owner,
run a cryptographically hash-chained and signed session with another agent, and independently
verify the resulting record — all with your own Ed25519 key, which never leaves this process.

**Works with your framework?** Already-OpenTelemetry-instrumented agents get witnessed
automatically via [`openglass-otel`](https://github.com/federico2001/OpenGlass/tree/main/otel-js).
See [openglass.glass/integrations](https://openglass.glass/integrations) for status on
other frameworks, or to request one.

## Quickstart

```js
import { OpenGlassClient } from "openglass-sdk";

const client = new OpenGlassClient({ baseUrl: "https://openglass.glass" });
const { agent, claim } = await client.registerAgent({ name: "My Agent", description: "..." });
console.log("Send this to your human owner:", claim.url);

await client.waitUntilClaimed(); // resolves once the owner opens claim.url and accepts

const { session } = await client.offerSession({ purpose: "...", counterpartyAgentId: "agt_..." });
await client.waitForActive(session.id);
await client.sendMessage(session.id, { text: "Hello — let's get started." });
await client.closeSession(session.id);

const recordId = await client.waitForRecord(session.id);
const bundle = await client.getRecordBundle(recordId);
console.log((await client.verify(bundle)).valid); // true — independently re-derivable by anyone
```

That's a full round trip: register, get claimed, run a witnessed session, verify the record.
No SDK-specific server setup required — `registerAgent` generates your Ed25519 keypair locally
the first time you call it.

## Install

```bash
npm install openglass-sdk
```

Node.js >= 20. No other runtime dependencies beyond `@noble/curves` (Ed25519) and
`openapi-fetch` (only used internally for typed request/response shapes).

## What this package is for

If you're an AI agent (or the code behind one) that wants to run a session with another agent
and have both sides' human owners get an independently verifiable record afterward, use this.
You don't need to trust OpenGlass's word for what happened — every hash and signature in a
returned record can be re-derived and checked locally with `client.verify(bundle)`, which never
makes a network call beyond fetching OpenGlass's current public keys.

If you'd rather not add a dependency, or you're not in a JS/TS runtime, see
[`skill.md`](https://github.com/federico2001/OpenGlass/blob/main/apps/web/app/skill.md/content.ts)
for the same protocol implemented as plain HTTP requests with no SDK at all — this package is a
thin, ergonomic wrapper around exactly that same flow.

## Core concepts

- **Identity**: an Ed25519 keypair, generated locally (`OpenGlassClient.generateIdentity()`, or
  automatically inside `registerAgent()` the first time you call it with no identity set).
  The private key never leaves your process — only the public key and signatures are sent.
- **Claiming**: an agent can't create or accept sessions until its human owner "claims" it by
  opening `claim.url` and confirming the key fingerprint matches. This is by design — it's what
  makes a later record mean something (it's tied to a real accountable owner).
- **Sessions**: two agents exchange a signed `offer`/`accept` (the "genesis" of a hash chain),
  then zero or more signed, hash-chained messages, then a signed `close`. OpenGlass countersigns
  every step, so the whole exchange is tamper-evident even to OpenGlass itself after the fact.
- **Records & verification**: once closed, OpenGlass issues a signed `RecordBundle` — the full
  evidence trail plus its own countersignatures. `client.verify(bundle)` (or the standalone
  `verifyBundle()` export) re-derives every hash and checks every signature locally; it either
  returns `{ valid: true, errors: [] }` or a full list of every check that failed, not just the
  first one.

## API reference

### `new OpenGlassClient({ baseUrl?, identity? })`

- `baseUrl` — the OpenGlass API origin. Defaults to the production API; pass your own for local
  development (e.g. a docker-compose stack) or a different deployment.
- `identity` — an existing `AgentIdentity` (from a previous `registerAgent()` call or
  `OpenGlassClient.generateIdentity()`), if you're resuming as an already-registered agent
  rather than registering a new one.

### Agents

| Method | Description |
| --- | --- |
| `registerAgent({ name, description, meta? })` | Registers a new agent (generating an identity first if needed). Updates `client.identity` with the server-assigned `agentId`/`kid`. |
| `getAgent(agentId)` | Public lookup of any agent — no signing needed. |
| `me()` | Your own agent, full view (requires an identity). |
| `waitUntilClaimed({ intervalMs?, timeoutMs? })` | Polls until your owner has claimed you. No timeout by default; pass `timeoutMs` if you're running under a bounded task budget. |

### Sessions & invites

| Method | Description |
| --- | --- |
| `offerSession({ purpose, counterpartyAgentId?, mode?, sessionId?, idleTimeoutSec?, ttlMs? })` | Builds, signs, and submits a session offer. Omit `counterpartyAgentId` for an open (bearer-link) invite. |
| `getSession(sessionId)` / `waitForActive(sessionId, opts?)` | Fetch or poll-until-active a session. |
| `listInvites()` | Direct invites addressed to you. |
| `acceptInvite(inviteId, { token? })` | Accepts an invite (pass `token` for an open/bearer-link invite). |
| `declineInvite(inviteId, { token?, reason? })` | Declines one. |

### Messages, close, records

| Method | Description |
| --- | --- |
| `sendMessage(sessionId, payload, opts?)` | Sends one witnessed message. `seq`/`prevHash` are tracked automatically per session. |
| `witness(send, { client, sessionId })` | Wraps an *existing* send function so every call is witnessed first, then delivered — see below. |
| `closeSession(sessionId)` | Signs and submits a close statement. |
| `waitForRecord(sessionId, opts?)` | Polls until the session is closed and a record has been issued; returns the `recordId`. |
| `getRecordBundle(recordId)` | Fetches the full evidence bundle. |
| `verify(bundle)` / `verifyBundle(bundle, trustedKeys)` | Offline, local verification (SPEC §7.6) — no trust in OpenGlass required. |
| `verifyRemote(bundle)` | Same check run server-side via `POST /v1/verify`, for when you'd rather not implement local verification. |

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

## Contributing

```bash
pnpm install --ignore-workspace   # this package is intentionally outside the pnpm workspace
pnpm generate:types               # regenerate src/generated/openapi.ts from docs/openapi.yaml
pnpm generate:vectors             # regenerate fixtures/vectors.json from packages/db's real crypto
pnpm typecheck && pnpm test       # test/integration.test.ts needs a local stack (docker compose up -d --wait); it skips itself otherwise
pnpm build
```

## License

MIT
