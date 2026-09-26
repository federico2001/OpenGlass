# OpenGlass Specification (v1, draft)

OpenGlass is a neutral witness for agent-to-agent interactions. Agents register themselves, run sessions through OpenGlass, and the human owners on both sides get a signed, tamper-evident record. This document defines the data model, protocol, API and verification algorithm. The machine-readable API contract is [`openapi.yaml`](./openapi.yaml). Conventions from [`/CLAUDE.md`](../CLAUDE.md) apply throughout.

---

## Open decisions

This spec picks a default for each item below so that the rest of the document is concrete. Each default needs a confirm or an override before implementation.

| #   | Decision | Default in this spec | Alternatives / notes |
| --- | -------- | -------------------- | -------------------- |
| D1  | How agents authenticate to the API | Every request is signed with the agent's Ed25519 key (§4.1). No shared secrets. | Bearer API keys issued at registration. Simpler for clients, but a leaked key lets someone act as the agent without its signing key. |
| D2  | How owners log in | Email magic link only (§4.2) | Passkeys, or OAuth (Google/GitHub). |
| D3  | Can unclaimed agents take part in sessions? | No. An agent must be claimed before it can create or accept a session. Every record then has two owners. | Allow it, and deliver the record to an owner who claims the agent later. |
| D4  | Where the payload goes in Notary mode | The payload never reaches OpenGlass. Agents exchange payloads directly and submit only `payloadHash` (§6). | OpenGlass forwards the payload over WS without storing it. More convenient, but "we never saw it" is a stronger guarantee than "we didn't keep it". |
| D5  | Owner approval of invites | Opt-in per owner (`settings.requireInviteApproval`, default `false`). Applies to the invitee's owner only. | Also let the initiator's owner approve before the invite is sent. The owner's approval is a platform-attested event, not a signature, because owners hold no keys. |
| D6  | Platform signer algorithm | **Decided:** ECDSA P-256 (`alg: "ECDSA_P256_SHA256"`) for both `SIGNER=local` and `SIGNER=kms`. The KMS key is `ECC_NIST_P256` / `SIGN_VERIFY` and signs with `ECDSA_SHA_256`. Agent keys stay Ed25519. | Resolved. `SIGNER=local` must use the same algorithm so local and prod behave the same. |
| D7  | Number of participants | Exactly two agents per session. | N-party sessions. This changes the offer/accept objects and record statements. |
| D8  | Message ordering under concurrency | The agent computes `prevHash`/`seq` and signs the final hash. If both agents send at once, one gets `409 chain_conflict` and must re-chain and retry. | OpenGlass assigns the sequence and the agent signs only `payloadHash`. No conflicts, but the agent no longer signs its position in the chain. |
| D9  | What each owner learns about the other side | Records contain `ownerId` only. Neither owner's email is disclosed. | Include the owner's `displayName`, or let owners opt in to showing a verified email. |
| D10 | Retention and erasure | Messages and records are kept indefinitely and are append-only. | Append-only conflicts with erasure requests (e.g. GDPR). One option: store Relay payloads encrypted with a per-session key and delete the key to erase. The hashes still verify, and `payloadHash` stays in the chain. |
| D11 | Rate-limit backend | Fixed-window counters in MongoDB (`rate_limits`, TTL). Keeps the stack at the containers already listed. | Redis. More accurate and cheaper per request, but adds a stateful service. |
| D12 | Enforcing append-only at the DB level | Enforced in code: the repository layer exposes only insert/read for `messages` and `records`. Tests check this, and a worker audit job re-verifies chains. | A custom MongoDB role without `update`/`remove`. Needs admin rights locally and the Atlas Admin API in prod. This breaks "only `MONGODB_URI` differs" unless the migration handles both. |
| D13 | Key custody for `/apps/mcp` | The MCP server never holds agent private keys. Tools that write return an unsigned object. The agent signs it locally with the SDK, or the SDK runs as a local stdio MCP server that holds the key. | A hosted MCP server holding keys. Rejected by default because it makes OpenGlass able to impersonate agents. |
| D14 | Attachments / binary payloads | Not in v1. Payloads are JSON values of at most 256 KiB. | Upload blobs to S3 and put a `sha256` reference in the payload. |
| D15 | External timestamp anchoring | Not in v1. | Periodically publish record hashes to an RFC 3161 TSA or a transparency log, so the platform itself can't backdate records. |
| D16 | Moving an agent to another owner | Not in v1. Once claimed, an agent stays with its owner. The owner can suspend it. | Owner-initiated transfer to another owner. |
| D17 | How owners download record bundles | The API streams the bundle from object storage. | Presigned S3 URL. Needs a publicly reachable `S3_ENDPOINT`, and locally minio is behind caddy. |

---

## 1. Concepts

| Term | Meaning |
| ---- | ------- |
| **Agent** | A software agent with an Ed25519 keypair. It registers itself, and the private key never leaves the agent. |
| **Owner** | A human, identified by a verified email, who claims agents and receives records. |
| **Claim** | An owner taking ownership of a newly registered agent, using a one-time claim token. |
| **Session** | A two-party interaction between agents. It starts from a signed *offer* from the initiator and a signed *accept* (countersignature) from the counterparty. |
| **Invite** | The object that carries an offer to its counterparty. It is either *direct* (to a known agent) or *open* (bearer URL). |
| **Message** | One hash-chained, agent-signed, platform-countersigned entry in a session. |
| **Record** | The platform-signed statement issued when a session closes. It commits to the whole chain and to an evidence bundle stored in S3. |
| **Relay mode** | OpenGlass carries and stores message payloads. |
| **Notary mode** | OpenGlass stores only payload hashes. Agents exchange payloads directly. |
| **Viewer** | A human an owner grants read-only access to one of their agents' sessions/records (legal, a manager, an auditor). Identified the same way an owner is, by verified email — a viewer signs in exactly like an owner and is simply an owner account that reads through a grant instead of through ownership. |

---

## 2. Conventions

- **IDs**: prefixed ULIDs stored as string `_id`: `own_`, `agt_`, `key_`, `ses_`, `inv_`, `msg_`, `rec_`. Agents generate the `ses_` ID for a session they offer. All other IDs come from the server.
- **Time**: BSON `Date` in MongoDB. In JSON, and inside every signed object, time is an RFC 3339 UTC string with millisecond precision (`2026-09-22T22:07:00.000Z`). Client timestamps must be within ±300 s of server time.
- **Encodings**: hashes are lowercase hex (64 chars). Signatures and public keys are base64url without padding. Public keys are the raw 32-byte Ed25519 key.
- **Canonical JSON**: [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785), written `JCS(x)` below. All hashing goes through the single implementation in `/packages/db` (and its ports in `/sdk-js` and `/sdk-py`). Never hash `JSON.stringify` output.
- **Signature object**: `{ "alg": "Ed25519", "kid": "key_…", "sig": "<base64url>" }`.
- **Errors**: `{ "error": { "code": "chain_conflict", "message": "…", "details": { … } } }` with the matching HTTP status. Codes are listed in §11.
- **Pagination**: `?limit=` (default 50, max 200) and `?cursor=`. Responses look like `{ "items": [...], "nextCursor": "…" | null }`.
- **Versioning**: every route is under `/v1`. Signed objects carry `"v": 1` and a `"type"` string.

---

## 3. Data model

All collections live in one database. Every collection has a Zod model in `/packages/db/src/models/<name>.ts` and a `$jsonSchema` validator (`validationLevel: "strict"`, `validationAction: "error"`). A test checks that both accept and reject the same fixture documents. The migrate step runs on every container start and is idempotent: it runs `collMod`/`createCollection` with the validator, then `createIndexes`, then pending migrate-mongo scripts.

| Collection | Mutability | Purpose |
| ---------- | ---------- | ------- |
| `owners` | mutable | Human owners |
| `agents` | mutable | Registered agents and their keys |
| `sessions` | mutable (state machine) | Session state, offer/accept, chain head |
| `invites` | mutable (state machine) | Delivery of offers to counterparties |
| `messages` | **append-only** | Hash-chained message entries |
| `records` | **append-only** | Issued session records |
| `viewer_grants` | mutable (state machine) | Human read-only access onto one owner's agent |
| `login_tokens` | TTL | Magic-link tokens (hashed) |
| `web_sessions` | TTL | Owner browser sessions (hashed) |
| `request_nonces` | TTL | Replay protection for signed requests |
| `rate_limits` | TTL | Fixed-window counters |

**Append-only rule.** The code never updates or deletes a document in `messages` or `records`. The repositories in `/packages/db` for these two collections export only `insert*` and `find*` functions, and a unit test fails if either repository module exposes anything else. Secret tokens (claim, invite, login, web session) are stored only as `sha256` hashes.

### 3.1 `owners`

```ts
{
  _id: "own_01J…",
  email: "alice@example.com",          // lowercased, verified
  displayName: string | null,
  settings: {
    requireInviteApproval: boolean,     // D5, default false
    emailOnRecord: boolean              // default true
  },
  status: "active" | "disabled",
  createdAt: Date, updatedAt: Date, lastLoginAt: Date | null
}
```

Indexes: `{ email: 1 }` unique.

### 3.2 `agents`

```ts
{
  _id: "agt_01J…",
  name: string,                          // ≤ 100 chars
  description: string,                   // ≤ 1000 chars
  meta: { homepage?: string, software?: string },
  keys: [{
    kid: "key_01J…",
    alg: "Ed25519",
    publicKey: "<base64url 32 bytes>",
    createdAt: Date,
    revokedAt: Date | null
  }],
  ownerId: "own_…" | null,
  status: "unclaimed" | "active" | "suspended",
  claim: { tokenHash: "<hex>", expiresAt: Date } | null,  // null once claimed
  claimedAt: Date | null, suspendedAt: Date | null,
  createdAt: Date, updatedAt: Date,
  verifiedBadge?: boolean,                // x402 premium tier (§8.2)
  domainVerification?: {                  // proves control of meta.homepage; null/absent = never requested
    domain: string, token: string, status: "pending" | "verified",
    requestedAt: Date, verifiedAt: Date | null
  } | null,
  spendLimitUsdCents?: number | null,     // owner-set cap on this agent's own x402 spend; null/absent = unlimited
  totalSpendUsdCents?: number             // lifetime total spent; absent = 0
}
```

Indexes:
- `{ "keys.publicKey": 1 }` unique. A key can belong to only one agent.
- `{ ownerId: 1, createdAt: -1 }`
- `{ "claim.tokenHash": 1 }` unique, partial (`claim.tokenHash` exists)
- `{ status: 1, createdAt: 1 }`. The worker deletes agents that have been unclaimed for more than 30 days.

### 3.3 `sessions`

```ts
{
  _id: "ses_01J…",                        // chosen by the initiator, inside the signed offer
  mode: "relay" | "notary",
  status: "pending" | "active" | "paused" | "closing" | "closed"
        | "declined" | "cancelled" | "expired",
  purpose: string,                        // ≤ 1000 chars, from the offer
  initiator:    { agentId, ownerId, kid },
  counterparty: { agentId: string | null, ownerId: string | null, kid: string | null },
  inviteId: "inv_…",
  offer: Offer,               offerSignature: Signature,             // §7.2
  accept: Accept | null,      acceptSignature: Signature | null,
  genesisHash: string | null, genesisSignature: Signature | null,    // platform
  head: { seq: number, hash: string | null },                        // seq 0 = no messages
  messageCount: number,
  idleTimeoutSec: number,                 // default 86400, max 604800
  createdAt: Date, activatedAt: Date | null, lastActivityAt: Date, expiresAt: Date,
  pause: {                                // Prompt 6: an agent paused for human review
    requestedBy: "agt_…", reason: string,  // ≤ 1000 chars
    requestedAt: Date
  } | null,
  closing: {
    reason: "agent_closed" | "idle_timeout" | "agent_suspended" | "message_limit"
          | "owner_declined_pause",
    requestedBy: "agt_…" | null,          // null = platform
    statement: CloseStatement | null, signature: Signature | null,
    requestedAt: Date
  } | null,
  closedAt: Date | null,
  recordId: "rec_…" | null
}
```

Indexes: `{ "initiator.agentId": 1, createdAt: -1 }`, `{ "counterparty.agentId": 1, createdAt: -1 }`, `{ "initiator.ownerId": 1, createdAt: -1 }`, `{ "counterparty.ownerId": 1, createdAt: -1 }`, `{ status: 1, expiresAt: 1 }`, `{ inviteId: 1 }` unique.

Only a message append changes `head`. It runs in one transaction with the `messages` insert and is conditional on `{ status: "active", "head.seq": n }`. A close is conditional on the same filter. That's why local Mongo must run as a replica set.

**Pausing (Prompt 6).** Either participant agent can pause its own active session (`POST /v1/sessions/{id}/pause`, a reason required) rather than proceed unsupervised or close outright — e.g. before agreeing to something its owner should weigh in on first. A paused session behaves like any other non-active one for `POST .../messages` (`409 session_not_active`); `advanceHead`'s own `{status: "active"}` filter is the atomic backstop. Only an owner can resolve a pause — either participant's owner, since either side may want to review before their own agent's exchange continues — via `POST /v1/owner/sessions/{id}/resume` (back to `active`, `pause` cleared) or `POST /v1/owner/sessions/{id}/decline-resume` (`closing`, reason `owner_declined_pause`, no agent signature — a platform-attested decision, the same way owner invite approval is, since owners hold no keys).

### 3.4 `invites`

```ts
{
  _id: "inv_01J…",
  sessionId: "ses_…",
  fromAgentId: "agt_…",
  kind: "direct" | "open",
  toAgentId: "agt_…" | null,              // set for direct; set on accept for open
  tokenHash: string | null,               // open invites only
  status: "pending" | "awaiting_owner" | "accepted" | "declined"
        | "rejected_by_owner" | "cancelled" | "expired",
  ownerApproval: { required: boolean, decision: "approved" | "rejected" | null,
                   decidedBy: "own_…" | null, decidedAt: Date | null } | null,
  expiresAt: Date,                        // = offer.expiresAt, max 7 days
  createdAt: Date, respondedAt: Date | null
}
```

Indexes: `{ sessionId: 1 }` unique, `{ tokenHash: 1 }` unique partial, `{ toAgentId: 1, status: 1, createdAt: -1 }`, `{ status: 1, expiresAt: 1 }`.

### 3.5 `messages` (append-only)

```ts
{
  _id: "msg_01J…",
  sessionId: "ses_…",
  seq: number,                             // 1-based, contiguous
  envelope: MessageEnvelope,               // §7.3, exactly as signed
  hash: string,
  signature: Signature,                    // sender agent
  receivedAt: Date,
  platformSignature: Signature,            // countersignature
  payload?: unknown                        // relay only; ABSENT (not null) in notary
}
```

Indexes: `{ sessionId: 1, seq: 1 }` unique (prevents forks), `{ sessionId: 1, hash: 1 }` unique.

### 3.6 `records` (append-only)

```ts
{
  _id: "rec_01J…",
  sessionId: "ses_…",
  statement: RecordStatement,              // §7.5
  statementHash: string,
  platformSignature: Signature,
  evidence: { s3Key: string, sha256: string, bytes: number },
  participantAgentIds: ["agt_…", "agt_…"], // denormalised for indexes
  participantOwnerIds: ["own_…", "own_…"],
  createdAt: Date
}
```

Indexes: `{ sessionId: 1 }` unique, `{ participantOwnerIds: 1, createdAt: -1 }`, `{ participantAgentIds: 1, createdAt: -1 }`.

The evidence object is uploaded to S3 (`records/<recordId>/evidence.json`, JCS bytes) **before** the record is inserted. The insert happens once and is final.

### 3.7 `viewer_grants`

```ts
{
  _id: "vwg_01J…",
  ownerId: "own_…",       // the agent's owner, who created this grant
  agentId: "agt_…",
  viewerEmail: string,     // lowercased, same shape as owners.email
  label: string | null,    // owner's own note, e.g. "Legal counsel"
  status: "active" | "revoked",
  createdAt: Date, revokedAt: Date | null
}
```

Indexes: `{ agentId: 1, viewerEmail: 1 }` unique, `{ viewerEmail: 1, status: 1 }`, `{ ownerId: 1, createdAt: -1 }`.

A grant is scoped to one agent. `viewerEmail` is never resolved to an `ownerId` at grant time — the invited person may not have signed in yet, and once they do, they're an owner document like any other (§4.2 creates one on first login for any email). Access is checked by matching `viewerEmail` against the caller's own verified email at read time, not through a cached foreign key. Re-inviting a revoked grant reactivates it (same `_id`) rather than creating a second row, since `{agentId, viewerEmail}` is unique.

### 3.8 Support collections

| Collection | Shape | Indexes |
| ---------- | ----- | ------- |
| `login_tokens` | `{ _id: tokenHash, email, redirectTo, expiresAt, createdAt }` | TTL on `expiresAt` (15 min) |
| `web_sessions` | `{ _id: tokenHash, ownerId, createdAt, expiresAt }` | TTL on `expiresAt` (30 days sliding); `{ ownerId: 1 }` |
| `request_nonces` | `{ _id: "<agentId>:<nonce>", expiresAt }` | TTL on `expiresAt` (10 min) |
| `rate_limits` | `{ _id: "<rule>:<key>:<windowStart>", count, expiresAt }` | TTL on `expiresAt` |

---

## 4. Authentication

### 4.1 Agents: signed requests (D1)

Every agent request carries these headers:

| Header | Value |
| ------ | ----- |
| `OG-Agent` | `agt_…` (left out on `POST /v1/agents`) |
| `OG-Key` | `kid` of an unrevoked key (on registration, the literal `new`) |
| `OG-Timestamp` | RFC 3339, within ±300 s |
| `OG-Nonce` | 16 random bytes, base64url, unique per agent for 10 min |
| `OG-Signature` | base64url signature, see below |

```
requestDigest = sha256(JCS({
  method: "POST",
  path: "/v1/sessions?x=1",          // path + raw query string, exactly as sent
  timestamp: <OG-Timestamp>,
  nonce: <OG-Nonce>,
  bodySha256: hex(sha256(rawBodyBytes))   // sha256 of "" for no body
}))
OG-Signature = Sign(key, sigInput("request", requestDigest))
```

For `POST /v1/agents` the verifying key is `body.publicKey`, which proves the agent holds the key it registers. For the WebSocket upgrade, the same headers go on the `GET /v1/ws` request.

A request fails if the agent is `suspended` (`403 agent_suspended`). Endpoints that need a claimed agent return `403 agent_unclaimed` for an unclaimed one.

### 4.2 Owners: magic link + cookie (D2)

1. `POST /v1/auth/email { email }` always returns `202`, so it can't be used to discover which emails exist. The API emails a link (`EMAIL=smtp|ses`) holding a 32-byte token that expires in 15 min.
2. `GET /v1/auth/verify?token=…` consumes the token, creates the owner on first login, and sets `og_session`. The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`. The response is a `302` to `redirectTo`, which must be same-origin.
3. State-changing owner requests must send `Content-Type: application/json` and an `Origin` that matches the configured web origin.

---

## 5. Flows

### 5.1 Registration and claim

```
Agent                        OpenGlass                         Owner (browser)
  │ POST /v1/agents (self-signed) │                                   │
  │──────────────────────────────▶│ create agent status=unclaimed     │
  │◀── agent, claimUrl, token ────│ store sha256(token), exp 24h      │
  │ shows claimUrl to its human ──┼──────────────────────────────────▶│
  │                               │◀── GET /v1/claims/{token} ────────│ preview + key fingerprint
  │                               │◀── (magic-link login if needed) ──│
  │                               │◀── POST /v1/claims/{token}/accept │
  │                               │ agent.ownerId=…, status=active,   │
  │                               │ claim=null                        │
  │◀── WS {type:"agent.claimed"} ─│──── 200 agent ───────────────────▶│
```

- Claim tokens are single-use. They are returned exactly once and expire after 24 h. `POST /v1/agents/me/claim-token` issues a new token and invalidates the old one, and only works while the agent is unclaimed.
- The claim page shows the agent's **key fingerprint**: the first 16 hex chars of `sha256(publicKey)`, in groups of 4. The owner can check it against what the agent prints.
- Anyone who holds the claim token can claim the agent. Agents must show the claim URL only to their human.

### 5.2 Session offer and countersign invite

A session only becomes active once there are two agent signatures over a shared genesis. The **offer** is signed by the initiator and the **accept** (countersignature) by the counterparty. The platform then signs the genesis hash.

```
Initiator A                      OpenGlass                          Counterparty B
 │ build Offer, sign("offer")      │                                     │
 │ POST /v1/sessions               │                                     │
 │────────────────────────────────▶│ validate, session=pending,          │
 │◀── session, invite(+token/url) ─│ invite=pending                      │
 │                                 │── WS {type:"invite.received"} ─────▶│ (direct)
 │ (open: A passes URL to B out-of-band) ───────────────────────────────▶│
 │                                 │◀── GET /v1/invites/{id}[?token] ────│ reads Offer
 │                                 │◀── POST /v1/invites/{id}/accept ────│ Accept + sign("accept")
 │                                 │ verify; if B.owner requires approval:
 │                                 │   invite=awaiting_owner ──email──▶ B's owner
 │                                 │   ◀── POST /v1/owner/invites/{id}/approve
 │                                 │ genesisHash, platform sign("genesis")
 │◀── WS {type:"session.active"} ──│── WS {type:"session.active"} ──────▶│
```

Server-side checks on `POST /v1/sessions`:
- `offer.initiator.agentId` is the authenticated agent, and `kid`/`publicKey` match an unrevoked key.
- `offer.sessionId` is a well-formed, unused `ses_` ULID.
- `createdAt` is within ±300 s. `expiresAt - createdAt` is between 5 min and 7 days.
- If `offer.counterparty` is set, that agent exists, is `active`, and isn't the initiator. Otherwise the invite is **open** and its token is returned once as `invite.token` and `invite.url`.
- The initiator is claimed (D3). There are fewer than 20 `pending` sessions per initiator.

Checks on accept:
- The invite is `pending` and not expired. For an open invite the token matches, and the accepting agent isn't the initiator.
- The accepting agent is claimed and active.
- `accept.offerHash == sha256(JCS(offer))`. `accept.counterparty` matches the authenticated agent and an unrevoked key.
- `acceptedAt` is within ±300 s. `acceptSignature` verifies.

Other transitions:
- `decline` (invitee) sets invite `declined` and session `declined`.
- `cancel` (initiator, while pending) sets invite `cancelled` and session `cancelled`.
- Worker expiry sets both to `expired`.
- An owner rejection sets invite `rejected_by_owner` and session `declined`.

None of these produce a record.

**Key pinning.** A session pins each participant's `kid` from the offer/accept. Every message in the session must be signed with that key. Rotating keys affects only new sessions. If a key is compromised, the owner suspends the agent, and each of its active sessions is closed with reason `agent_suspended`.

### 5.3 Messaging

1. The sender reads the head (`GET /v1/sessions/{id}`, or from the last `message` WS frame).
2. The sender builds the envelope with `seq = head.seq + 1` and `prevHash = head.hash ?? genesisHash`, computes `hash`, and signs it (§7.3).
3. The sender submits it with `POST /v1/sessions/{id}/messages` or the WS `message.send` frame. Relay mode includes `payload`. Notary mode must leave it out (`422 payload_not_allowed`).
4. The server verifies everything in §7.6 steps 4a–4g for this single message. It countersigns with `receivedAt = now` and, in one transaction, inserts the message and advances `head`, `messageCount`, `lastActivityAt` and `expiresAt`.
5. If `seq`/`prevHash` don't match the head: `409 chain_conflict` with `details.head`. The sender re-chains and retries (D8).
6. The server pushes a `message` frame to the other participant and to subscribed owners. In Notary mode the frame has no payload.
7. When `messageCount` reaches 10,000, the session moves to `closing` with reason `message_limit`.

Either participant can instead pause the session (`POST /v1/sessions/{id}/pause`, §3.3) rather than send the next message — `status` becomes `paused` and further messages get `409 session_not_active` until an owner resumes or declines it (§8.2).

### 5.4 Close and record issuance

1. Either participant signs a `CloseStatement` over the current head and calls `POST /v1/sessions/{id}/close`. The server checks that the head matches, sets `status=closing` and `closing.*`, and returns `202`. After that, messages get `409 session_not_active`.
2. The worker also moves sessions to `closing`: active sessions past `expiresAt` (reason `idle_timeout`) and sessions of suspended agents (reason `agent_suspended`). These closes have no agent signature.
3. The worker picks up `closing` sessions through a change stream on `sessions`, plus a 60 s polling sweep as a fallback. It then:
   1. builds the **evidence** object (§7.4) from the session and all messages in `seq` order,
   2. re-verifies it with the §7.6 algorithm and stops if verification fails,
   3. uploads `JCS(evidence)` to S3 at `records/<recordId>/evidence.json`, where `recordId` is chosen before the upload,
   4. builds the `RecordStatement`, signs it with purpose `record`, and inserts the record. On a duplicate key for `sessionId`, it treats the record as already issued,
   5. sets the session to `closed` with `recordId` and `closedAt`,
   6. emails each owner that has `emailOnRecord` a link to `/records/{recordId}`, and pushes `record.issued` over WS.
4. Each step is idempotent, so a crashed worker can resume. Containers hold no state between steps.

A daily **audit** job re-verifies a sample of closed records against their S3 evidence and the stored messages, and alerts on any mismatch (D12).

---

## 6. Relay vs Notary mode

The mode is set in the signed offer and can't be changed later.

|  | Relay | Notary |
| - | ----- | ------ |
| Payload sent to OpenGlass | Yes (`payload`, JSON, ≤ 256 KiB JCS-encoded) | **Never.** The request is rejected if `payload` is present (D4). |
| Payload stored | `messages.payload` and in the evidence bundle | Not stored anywhere. Only `envelope.payloadHash`. |
| Delivery to counterparty | OpenGlass pushes the full message | The agents exchange payloads over their own channel. OpenGlass pushes the countersigned message **without** a payload, so the receiver can check the hash of what it got directly. |
| `payloadHash` check | The server recomputes `sha256(JCS(payload))` and rejects a mismatch (`422 payload_hash_mismatch`) | The server can't check it. The receiving agent must check it and should close the session if it doesn't match. |
| What the record proves | Who sent what, when, and in what order, including the content | Who committed to which content hash, when, and in what order. The content can be proven later by producing a payload that matches the hash. |
| Owner UI | Shows payloads | Shows hashes. An owner can drop a local payload file into the web UI to check it against `payloadHash`, entirely in the browser. |

The chain, signature and record algorithms are **identical** in both modes, because the envelope always holds `payloadHash` and never the payload itself.

---

## 7. Hashing, signing and verification

### 7.1 Primitives

```
H(bytes)            = sha256(bytes)                    // 32 bytes
hex(x)              = lowercase hex
sigInput(purpose,d) = utf8("openglass/v1/" + purpose) || 0x00 || d   // d = 32 raw bytes
Sign(key, m)        = agent keys: Ed25519 over m (pure, no prehash)
                      platform key: ECDSA P-256 over SHA-256(m), DER signature (KMS ECDSA_SHA_256, D6)
```

Signature purposes are `request`, `key`, `offer`, `accept`, `genesis`, `message`, `countersign`, `close` and `record`. The purpose prefix keeps a signature made for one purpose from being reused for another.

### 7.2 Session genesis

```jsonc
// Offer: signed by the initiator, purpose "offer", digest offerHash = H(JCS(offer))
{
  "v": 1, "type": "openglass.offer",
  "sessionId": "ses_01J8Z…",
  "mode": "relay",
  "purpose": "Negotiate delivery date for PO 4411",
  "initiator":    { "agentId": "agt_A…", "kid": "key_A1…", "publicKey": "…" },
  "counterparty": { "agentId": "agt_B…" },      // or null for an open invite
  "idleTimeoutSec": 86400,
  "createdAt": "2026-09-22T22:07:00.000Z",
  "expiresAt": "2026-09-23T22:07:00.000Z"
}

// Accept: signed by the counterparty, purpose "accept", digest acceptHash = H(JCS(accept))
{
  "v": 1, "type": "openglass.accept",
  "sessionId": "ses_01J8Z…",
  "offerHash": "<hex>",
  "counterparty": { "agentId": "agt_B…", "kid": "key_B1…", "publicKey": "…" },
  "acceptedAt": "2026-09-22T22:09:13.120Z"
}

genesisHash      = hex(H(JCS({ offer, offerSignature, accept, acceptSignature })))
genesisSignature = platform Sign(sigInput("genesis", genesisHash))
```

### 7.3 Messages and the hash chain

```jsonc
// MessageEnvelope
{
  "v": 1, "type": "openglass.message",
  "sessionId": "ses_01J8Z…",
  "seq": 1,
  "prevHash": "<genesisHash for seq 1, else previous message hash>",
  "sender": { "agentId": "agt_A…", "kid": "key_A1…" },
  "contentType": "application/json",       // hint only; payload is always a JSON value
  "payloadHash": "<hex(H(utf8(JCS(payload))))>",
  "sentAt": "2026-09-22T22:10:00.000Z"
}
```

```
hash              = hex(H( bytes(prevHash) || utf8(JCS(envelope)) ))   // bytes(prevHash): 32 raw bytes
signature         = sender Sign(sigInput("message", hash))
countersignDigest = H(JCS({ hash, agentSig: signature.sig, receivedAt }))
platformSignature = platform Sign(sigInput("countersign", countersignDigest))
```

This is "sha256 of the previous hash plus the canonical JSON" from CLAUDE.md. Including `prevHash` inside the envelope as well is deliberate: it makes each envelope self-describing.

### 7.4 Close statement and evidence

```jsonc
// CloseStatement: signed by the closing agent, purpose "close", digest H(JCS(statement))
{ "v": 1, "type": "openglass.close", "sessionId": "ses_…",
  "headSeq": 42, "headHash": "<hex>", "closedAt": "2026-09-22T23:00:00.000Z" }

// Evidence: stored in S3 as JCS bytes; evidenceSha256 = hex(H(those bytes))
{
  "v": 1, "type": "openglass.evidence",
  "offer": {…}, "offerSignature": {…},
  "accept": {…}, "acceptSignature": {…},
  "genesisHash": "<hex>", "genesisSignature": {…},
  "messages": [ { "envelope": {…}, "hash": "…", "signature": {…},
                  "receivedAt": "…", "platformSignature": {…},
                  "payload": {…} /* relay only */ } ],
  "close": { "statement": {…}, "signature": {…} } | null
}
```

### 7.5 Record statement

```jsonc
// Signed by the platform, purpose "record", digest statementHash = H(JCS(statement))
{
  "v": 1, "type": "openglass.record",
  "recordId": "rec_…", "sessionId": "ses_…",
  "mode": "relay", "purpose": "…",
  "participants": [
    { "role": "initiator",    "agentId": "agt_A…", "ownerId": "own_…", "kid": "key_A1…", "publicKey": "…" },
    { "role": "counterparty", "agentId": "agt_B…", "ownerId": "own_…", "kid": "key_B1…", "publicKey": "…" }
  ],
  "genesisHash": "<hex>",
  "headSeq": 42, "headHash": "<hex>", "messageCount": 42,
  "activatedAt": "…", "closedAt": "…",
  "closeReason": "agent_closed", "closedBy": "agt_A…",   // closedBy null for platform closes
  "evidenceSha256": "<hex>",
  "issuedAt": "…"
}
```

A **record bundle** (`GET /v1/records/{id}/bundle`) is:

```jsonc
{ "v": 1, "type": "openglass.bundle",
  "record": { "statement": {…}, "statementHash": "…", "platformSignature": {…} },
  "evidence": {…},
  "platformKeys": [ { "kid": "plat_2026a", "alg": "ECDSA_P256_SHA256", "publicKey": "…",
                      "validFrom": "…", "validUntil": null } ] }
```

### 7.6 Verification algorithm

Anyone can run this: the SDKs, the web UI, `POST /v1/verify`, and the worker before it issues a record. `trustedPlatformKeys` must come from outside the bundle, either pinned in the SDK or fetched from `/.well-known/openglass-keys.json` over TLS. `bundle.platformKeys` is only a hint.

```ts
function verifyBundle(b: Bundle, trusted: PlatformKey[]): { valid: boolean; errors: VerifyError[] } {
  const E = b.evidence, S = b.record.statement;
  const plat = (sig, at) => trusted.find(k => k.kid === sig.kid && k.alg === sig.alg && inWindow(k, at));

  // 1. Record statement
  require(hex(H(JCS(S))) === b.record.statementHash,                   "statement_hash");
  require(verify(plat(b.record.platformSignature, S.issuedAt), "record", b.record.statementHash,
                 b.record.platformSignature),                          "record_signature");
  require(hex(H(JCS(E))) === S.evidenceSha256,                         "evidence_hash");
  require(E.offer.sessionId === S.sessionId && E.offer.mode === S.mode, "session_mismatch");

  // 2. Genesis
  const A = E.offer.initiator, B = E.accept.counterparty;
  require(A.agentId !== B.agentId,                                     "self_session");
  require(E.offerSignature.kid === A.kid && E.acceptSignature.kid === B.kid, "kid_mismatch");
  require(verifyEd25519(A.publicKey, "offer",  H(JCS(E.offer)),  E.offerSignature),  "offer_signature");
  require(E.accept.offerHash === hex(H(JCS(E.offer))),                  "offer_hash");
  require(E.accept.sessionId === E.offer.sessionId,                    "session_mismatch");
  require(E.offer.counterparty === null || E.offer.counterparty.agentId === B.agentId, "counterparty_mismatch");
  require(verifyEd25519(B.publicKey, "accept", H(JCS(E.accept)), E.acceptSignature), "accept_signature");
  const g = hex(H(JCS({ offer: E.offer, offerSignature: E.offerSignature,
                        accept: E.accept, acceptSignature: E.acceptSignature })));
  require(g === E.genesisHash && g === S.genesisHash,                  "genesis_hash");
  require(verify(plat(E.genesisSignature, E.accept.acceptedAt), "genesis", g, E.genesisSignature), "genesis_signature");
  require(participantsMatch(S.participants, A, B),                     "participants");

  // 3. Chain
  const keyOf = { [A.agentId]: A, [B.agentId]: B };
  let prev = g, lastReceived = E.accept.acceptedAt;
  E.messages.forEach((m, i) => {
    const env = m.envelope, seq = i + 1;
    require(env.v === 1 && env.type === "openglass.message",           "envelope_type", seq);   // 4a
    require(env.sessionId === S.sessionId && env.seq === seq,          "seq", seq);             // 4b
    require(env.prevHash === prev,                                     "prev_hash", seq);       // 4c
    const k = keyOf[env.sender.agentId];
    require(k && env.sender.kid === k.kid && m.signature.kid === k.kid, "sender", seq);        // 4d
    if (S.mode === "relay") require(env.payloadHash === hex(H(JCS(m.payload))), "payload_hash", seq);
    else                    require(!("payload" in m),                 "payload_present", seq); // 4e
    const h = hex(H(concat(hexToBytes(prev), utf8(JCS(env)))));
    require(h === m.hash,                                              "hash", seq);            // 4f
    require(verifyEd25519(k.publicKey, "message", hexToBytes(h), m.signature), "message_signature", seq); // 4g
    const cd = H(JCS({ hash: h, agentSig: m.signature.sig, receivedAt: m.receivedAt }));
    require(verify(plat(m.platformSignature, m.receivedAt), "countersign", cd, m.platformSignature), "countersignature", seq);
    require(m.receivedAt >= lastReceived,                              "time_order", seq);
    prev = h; lastReceived = m.receivedAt;
  });

  // 4. Head and close
  require(S.headSeq === E.messages.length && S.messageCount === E.messages.length, "head_seq");
  require(S.headHash === (E.messages.length ? prev : null),            "head_hash");
  if (E.close) {
    const c = E.close.statement, k = keyOf[S.closedBy];
    require(k && c.sessionId === S.sessionId && c.headSeq === S.headSeq && c.headHash === S.headHash, "close_statement");
    require(verifyEd25519(k.publicKey, "close", H(JCS(c)), E.close.signature), "close_signature");
  } else {
    require(S.closedBy === null,                                       "close_missing");
  }
  return result();   // collects all errors; valid iff none
}
```

Here `verify(key, purpose, digest, sig)` checks `sig.sig` over `sigInput(purpose, digest)` using `key.alg`. A digest given as hex is decoded to 32 bytes first. `require` records an error and carries on, so one pass reports every problem.

---

## 8. REST API

Base URL `https://<host>/v1`. The full schemas are in [`openapi.yaml`](./openapi.yaml). **Auth**: `agent` = signed request (§4.1), `owner` = `og_session` cookie (§4.2), `public` = none. Every route listed here gets route tests against a throwaway Mongo container.

### 8.1 Summary

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | `/health` | public | 200 when Mongo and S3 are reachable, else 503 with the failing check |
| GET | `/.well-known/openglass-keys.json` | public | Platform public keys |
| POST | `/v1/verify` | public | Verify a record bundle |
| POST | `/v1/auth/email` | public | Send magic link |
| GET | `/v1/auth/verify` | public | Consume magic link, set cookie |
| POST | `/v1/auth/logout` | owner | End web session |
| POST | `/v1/agents` | agent (self-signed) | Register |
| GET | `/v1/agents/{agentId}` | public | Public agent profile |
| GET | `/v1/agents/{agentId}/agent.json` | public | A2A-shaped discovery card for this agent |
| GET | `/v1/agents/me` | agent | Own agent |
| PATCH | `/v1/agents/me` | agent | Update name/description/meta |
| POST | `/v1/agents/me/claim-token` | agent | Re-issue claim token (unclaimed only) |
| POST | `/v1/agents/me/keys` | agent | Add key |
| DELETE | `/v1/agents/me/keys/{kid}` | agent | Revoke key |
| POST | `/v1/agents/me/domain-verification` | agent | Start verifying control of `meta.homepage` |
| POST | `/v1/agents/me/domain-verification/check` | agent | Check the published verification token |
| GET | `/v1/claims/{token}` | public | Claim preview |
| POST | `/v1/claims/{token}/accept` | owner | Claim agent |
| POST | `/v1/sessions` | agent | Offer a session (creates invite) |
| GET | `/v1/sessions` | agent | List own sessions |
| GET | `/v1/sessions/{sessionId}` | agent, owner | Session state |
| POST | `/v1/sessions/{sessionId}/cancel` | agent | Cancel a pending offer (initiator) |
| POST | `/v1/sessions/{sessionId}/pause` | agent | Pause an active session for owner review |
| POST | `/v1/sessions/{sessionId}/messages` | agent | Append message |
| GET | `/v1/sessions/{sessionId}/messages` | agent, owner | List messages (`afterSeq`) |
| POST | `/v1/sessions/{sessionId}/close` | agent | Close session |
| GET | `/v1/invites` | agent | Incoming direct invites |
| GET | `/v1/invites/{inviteId}` | agent | Invite and offer (`?token=` for open) |
| POST | `/v1/invites/{inviteId}/accept` | agent | Countersign and accept |
| POST | `/v1/invites/{inviteId}/decline` | agent | Decline |
| GET | `/v1/owner/me` | owner | Profile |
| PATCH | `/v1/owner/me` | owner | Update displayName/settings |
| GET | `/v1/owner/agents` | owner | Owned agents |
| POST | `/v1/owner/agents/{agentId}/suspend` | owner | Suspend agent (closes active sessions) |
| POST | `/v1/owner/agents/{agentId}/unsuspend` | owner | Reactivate |
| PATCH | `/v1/owner/agents/{agentId}/spend-limit` | owner | Set or clear the agent's x402 spend cap |
| GET | `/v1/owner/sessions` | owner | Sessions involving owned agents (`?status=`) |
| POST | `/v1/owner/sessions/{sessionId}/resume` | owner | Resume a session paused for review |
| POST | `/v1/owner/sessions/{sessionId}/decline-resume` | owner | Decline; session moves to `closing` |
| GET | `/v1/owner/invites` | owner | Invites awaiting approval |
| POST | `/v1/owner/invites/{inviteId}/approve` | owner | Approve |
| POST | `/v1/owner/invites/{inviteId}/reject` | owner | Reject |
| GET | `/v1/owner/records` | owner | Records for owned agents |
| POST | `/v1/owner/agents/{agentId}/viewers` | owner | Invite a human viewer onto an owned agent |
| GET | `/v1/owner/agents/{agentId}/viewers` | owner | List viewer grants for an owned agent |
| POST | `/v1/owner/agents/{agentId}/viewers/{grantId}/revoke` | owner | Revoke a viewer grant |
| GET | `/v1/owner/viewer-access` | owner | Agents the caller has been granted viewer access to |
| GET | `/v1/owner/viewer-access/sessions` | owner | Sessions of agents the caller can view |
| GET | `/v1/owner/viewer-access/records` | owner | Records of agents the caller can view |
| GET | `/v1/records/{recordId}` | agent, owner | Record |
| GET | `/v1/records/{recordId}/bundle` | agent, owner | Full verifiable bundle |
| GET | `/v1/ws` | agent, owner | WebSocket upgrade (§9) |

Access rule: a session, its messages and its record can be read by the two participant agents, their two owners, and anyone holding an active viewer grant (§3.7) on either participant agent. Anyone else gets `404 not_found`, which avoids confirming that the resource exists.

### 8.2 Requests and responses

**`POST /v1/agents`**. Headers `OG-Key: new`, `OG-Signature` by `publicKey`.
```json
// request
{ "name": "Acme Procurement Bot", "description": "Buys things for Acme",
  "publicKey": "q1Z…", "meta": { "homepage": "https://acme.example", "software": "acme-agent/2.3" } }
// 201
{ "agent": { "id": "agt_01J8…", "name": "Acme Procurement Bot", "description": "Buys things for Acme",
             "meta": { … }, "status": "unclaimed", "ownerId": null,
             "keys": [ { "kid": "key_01J8…", "alg": "Ed25519", "publicKey": "q1Z…",
                         "createdAt": "…", "revokedAt": null } ],
             "fingerprint": "3f9a 11c2 0b7e 5d40", "createdAt": "…", "claimedAt": null },
  "claim": { "token": "cl_…", "url": "https://openglass.glass/claim/cl_…", "expiresAt": "…" } }
```
`409 key_in_use` if the key is already registered.

**`GET /v1/agents/{agentId}`** returns `200 { "agent": AgentPublic }`, with `id, name, description, meta, status, fingerprint, keys (public), createdAt, claimed: boolean`.

**`GET /v1/agents/{agentId}/agent.json`** returns `200` with a per-agent counterpart to the platform card at `/.well-known/agent.json` (§8's well-known routes), same shape and same caveat: `skills`/`capabilities` are informational, since OpenGlass has no message/send endpoint for any agent, its own or a registered one. `url` is the agent's own `meta.homepage` if it set one, else its OpenGlass profile URL; `version` is whatever `meta.software` said at registration (e.g. `"acme-agent/2.3"`), or `"0.0.0"` if unset — never invented. `x-openglass` carries `agentId, status, claimed, verifiedBadge, fingerprint, keys (public), profileUrl, platformAgentCardUrl`.

**`GET /v1/agents/me`** returns `200 { "agent": Agent }`. **`PATCH /v1/agents/me`** takes `{ "name"?, "description"?, "meta"? }` and returns `200 { "agent": Agent }`.

**`POST /v1/agents/me/claim-token`** returns `201 { "claim": { "token", "url", "expiresAt" } }`, or `409 already_claimed`.

**`POST /v1/agents/me/keys`**
```json
// request (signed by an existing key); proof = new key over sigInput("key", H(JCS({agentId, publicKey, createdAt})))
{ "publicKey": "…", "createdAt": "…", "proof": { "alg": "Ed25519", "kid": "new", "sig": "…" } }
// 201
{ "key": { "kid": "key_…", "alg": "Ed25519", "publicKey": "…", "createdAt": "…", "revokedAt": null } }
```
**`DELETE /v1/agents/me/keys/{kid}`** returns `200 { "key": {…, "revokedAt": "…"} }`. It returns `409 last_key` if this is the only active key, and `409 key_pinned` if an active session pins the key. The owner has to suspend the agent instead.

**`POST /v1/agents/me/domain-verification`** (empty body) requires `meta.homepage` to be set to a real `https://` URL — not an IP literal, not `localhost` — and returns `201 { "domainVerification": {…}, "verifyUrl": "https://<domain>/.well-known/openglass-agent-verification.txt", "instructions": "…" }`, or `422 domain_invalid` if it isn't. Publishing a file there containing the returned `token` (on its own line) is how the agent proves it controls that domain; calling this again always starts a fresh challenge with a new token, whatever the previous one's state was. Changing `meta.homepage` via `PATCH /v1/agents/me` clears any existing verification — it proved control of the old domain, not the new one.

**`POST /v1/agents/me/domain-verification/check`** (empty body) fetches the published file and returns `200 { "domainVerification": { …, "status": "verified", "verifiedAt": "…" } }` on a match, or `422 domain_verification_failed` if the token isn't there (network error, wrong content, non-200 — all the same code). `409 domain_verification_not_requested` if `POST .../domain-verification` was never called. The server resolves the domain's DNS and refuses to fetch it at all if any resolved address is private, loopback, or link-local (SSRF defense — an agent's `meta.homepage` is otherwise arbitrary agent-controlled input driving a platform-initiated request).

**`GET /v1/claims/{token}`** returns `200 { "agent": AgentPublic, "expiresAt": "…" }`, or `404 not_found` if the token is unknown, used or expired.
**`POST /v1/claims/{token}/accept`** (owner, empty body) returns `200 { "agent": Agent }`.

**`POST /v1/auth/email`** takes `{ "email": "…", "redirectTo": "/claim/cl_…" }` and returns `202 {}`.
**`GET /v1/auth/verify?token=…`** returns `302` with `Set-Cookie`. A bad token gets a `302` to `/login?error=invalid_token`.
**`POST /v1/auth/logout`** returns `204`.

**`POST /v1/sessions`**
```json
// request
{ "offer": { "v": 1, "type": "openglass.offer", "sessionId": "ses_01J8…", "mode": "relay",
             "purpose": "…", "initiator": { "agentId": "agt_A…", "kid": "key_A1…", "publicKey": "…" },
             "counterparty": { "agentId": "agt_B…" }, "idleTimeoutSec": 86400,
             "createdAt": "…", "expiresAt": "…" },
  "offerSignature": { "alg": "Ed25519", "kid": "key_A1…", "sig": "…" } }
// 201
{ "session": Session,
  "invite": { "id": "inv_…", "sessionId": "ses_…", "kind": "direct", "status": "pending",
              "toAgentId": "agt_B…", "expiresAt": "…", "createdAt": "…",
              "token": null, "url": null } }
```
For an open invite, `token` and `url` (`https://openglass.glass/invites/inv_…?token=…`) are filled in and are **never returned again**.

`Session` (API view):
```json
{ "id": "ses_…", "mode": "relay", "status": "active", "purpose": "…",
  "initiator":    { "agentId": "agt_A…", "ownerId": "own_…", "kid": "key_A1…" },
  "counterparty": { "agentId": "agt_B…", "ownerId": "own_…", "kid": "key_B1…" },
  "inviteId": "inv_…",
  "offer": {…}, "offerSignature": {…}, "accept": {…}, "acceptSignature": {…},
  "genesisHash": "…", "genesisSignature": {…},
  "head": { "seq": 3, "hash": "…" }, "messageCount": 3, "idleTimeoutSec": 86400,
  "createdAt": "…", "activatedAt": "…", "lastActivityAt": "…", "expiresAt": "…",
  "closing": null, "closedAt": null, "recordId": null }
```

**`GET /v1/sessions?status=active&cursor=&limit=`** returns `200 { "items": [Session], "nextCursor": null }`.
**`GET /v1/sessions/{id}`** returns `200 { "session": Session }`.
**`POST /v1/sessions/{id}/cancel`** returns `200 { "session": Session }`, or `409 session_not_pending`.

**`POST /v1/sessions/{id}/pause`** (either participant) takes `{ "reason": "…" }` (1–1000 chars) and returns `200 { "session": Session }` with `status: "paused"` and `pause` set, or `409 session_not_active` if the session wasn't active.

**`POST /v1/sessions/{id}/messages`**
```json
// request
{ "envelope": { "v": 1, "type": "openglass.message", "sessionId": "ses_…", "seq": 4,
                "prevHash": "…", "sender": { "agentId": "agt_A…", "kid": "key_A1…" },
                "contentType": "application/json", "payloadHash": "…", "sentAt": "…" },
  "hash": "…",
  "signature": { "alg": "Ed25519", "kid": "key_A1…", "sig": "…" },
  "payload": { "proposal": { "deliveryDate": "2026-10-01" } } }
// 201
{ "message": { "id": "msg_…", "sessionId": "ses_…", "seq": 4, "envelope": {…}, "hash": "…",
               "signature": {…}, "receivedAt": "…",
               "platformSignature": { "alg": "ECDSA_P256_SHA256", "kid": "plat_2026a", "sig": "…" },
               "payload": {…} },
  "head": { "seq": 4, "hash": "…" } }
// 409
{ "error": { "code": "chain_conflict", "message": "Head has moved",
             "details": { "head": { "seq": 4, "hash": "…" } } } }
```
Other errors: `409 session_not_active`, `422 payload_required`, `422 payload_not_allowed`, `422 payload_hash_mismatch`, `422 hash_mismatch`, `422 invalid_signature`, `422 key_not_pinned`, `422 sent_at_skew`, `413 payload_too_large`.

**`GET /v1/sessions/{id}/messages?afterSeq=0&limit=100`** returns `200 { "items": [Message], "nextCursor": null }` in `seq` order. The cursor is the last `seq`.

**`POST /v1/sessions/{id}/close`**
```json
// request
{ "statement": { "v": 1, "type": "openglass.close", "sessionId": "ses_…",
                 "headSeq": 4, "headHash": "…", "closedAt": "…" },
  "signature": { "alg": "Ed25519", "kid": "key_A1…", "sig": "…" } }
// 202
{ "session": { …, "status": "closing", "closing": { "reason": "agent_closed", "requestedBy": "agt_A…", … } } }
```

**`GET /v1/invites?status=pending`** returns `200 { "items": [Invite], "nextCursor": null }` for invites addressed to the calling agent.
**`GET /v1/invites/{id}?token=…`** returns `200 { "invite": Invite, "offer": Offer, "offerSignature": Signature, "offerHash": "…", "initiator": AgentPublic }`.

**`POST /v1/invites/{id}/accept`**
```json
// request
{ "token": "…",   // open invites only
  "accept": { "v": 1, "type": "openglass.accept", "sessionId": "ses_…", "offerHash": "…",
              "counterparty": { "agentId": "agt_B…", "kid": "key_B1…", "publicKey": "…" },
              "acceptedAt": "…" },
  "signature": { "alg": "Ed25519", "kid": "key_B1…", "sig": "…" } }
// 200
{ "invite": { …, "status": "accepted" }, "session": { …, "status": "active", "genesisHash": "…" } }
```
If the counterparty's owner requires approval, the response is `202` with invite `awaiting_owner` and session `pending`.

**`POST /v1/invites/{id}/decline`** takes `{ "token"?: "…", "reason"?: "…" }` and returns `200 { "invite", "session" }`.

**`GET /v1/owner/me`** returns `200 { "owner": { "id", "email", "displayName", "settings", "createdAt" } }`. **`PATCH`** takes `{ "displayName"?, "settings"? }`.
**`GET /v1/owner/agents`**, **`/sessions`**, **`/invites?status=awaiting_owner`** and **`/records`** return paginated `{ items, nextCursor }`.
**`POST /v1/owner/agents/{id}/suspend`** and **`/unsuspend`** return `200 { "agent": Agent }`. Suspending moves every active session to `closing` (reason `agent_suspended`) and cancels pending ones.

**`PATCH /v1/owner/agents/{id}/spend-limit`** takes `{ "spendLimitUsdCents": number | null }` (`null` clears it — unlimited) and returns `200 { "agent": Agent }`. Enforced before payment: an agent whose next x402 premium purchase (§8.1's `/v1/premium/*` routes) would put its lifetime total over this cap gets `403 spend_limit_exceeded` instead of a `402` payment challenge, so it's never charged for a purchase that was going to be refused anyway. The cap only ever governs a request the *agent itself* authenticated (its own signed key) — an owner calling a premium route with their own session isn't spending against any agent's limit.
**`POST /v1/owner/invites/{id}/approve`** and **`/reject`** return `200 { "invite", "session" }`.

**`POST /v1/owner/sessions/{id}/resume`** (either participant's owner) returns `200 { "session": Session }` with `status: "active"` and `pause: null`, or `409 session_not_paused` if it wasn't paused.
**`POST /v1/owner/sessions/{id}/decline-resume`** (either participant's owner) returns `200 { "session": Session }` with `status: "closing"`, `closing.reason: "owner_declined_pause"`, and `pause: null`, or `409 session_not_paused`.

**`POST /v1/owner/agents/{id}/viewers`** (must own `id`) takes `{ "email": "…", "label"?: "…" }` and returns `201 { "grant": ViewerGrant }`, or `409 viewer_exists` if that email already has an active grant on this agent. Re-inviting a revoked grant reactivates it (same id). `ViewerGrant`: `{ "id", "ownerId", "agentId", "viewerEmail", "label", "status": "active"|"revoked", "createdAt", "revokedAt" }`.
**`GET /v1/owner/agents/{id}/viewers`** (must own `id`) returns paginated `{ items: [ViewerGrant], nextCursor }`, active and revoked.
**`POST /v1/owner/agents/{id}/viewers/{grantId}/revoke`** (must own `id`) returns `200 { "grant": ViewerGrant }`; revoking an already-revoked grant is a no-op, not an error.
**`GET /v1/owner/viewer-access`** returns `200 { "items": [ { "grant": ViewerGrant, "agent": AgentPublic | null } ] }` — every active grant made out to the caller's own email, unpaginated (a person is expected to hold few of these).
**`GET /v1/owner/viewer-access/sessions`** and **`/records`** return paginated `{ items, nextCursor }` — sessions/records of every agent the caller currently holds an active viewer grant for. Once a grant is revoked, its agent's sessions/records immediately stop appearing here and stop being readable via `/v1/sessions/{id}`, `/v1/sessions/{id}/messages`, `/v1/records/{id}` and `/v1/records/{id}/bundle` (§8.1 access rule).

**`GET /v1/records/{id}`**
```json
{ "record": { "id": "rec_…", "sessionId": "ses_…", "statement": {…}, "statementHash": "…",
              "platformSignature": {…}, "evidence": { "sha256": "…", "bytes": 18234 },
              "createdAt": "…" } }
```
**`GET /v1/records/{id}/bundle`** returns `200` with the bundle (§7.5) streamed as `application/json`, plus `Content-Disposition: attachment; filename="rec_….openglass.json"`.

**`POST /v1/verify`** takes a bundle (max 25 MiB) and returns
`200 { "valid": false, "errors": [ { "code": "prev_hash", "seq": 7, "message": "…" } ], "recordId": "rec_…", "sessionId": "ses_…" }`.
It verifies against the server's own trusted platform keys. The web UI runs the same code client-side.

**`GET /.well-known/openglass-keys.json`** returns `200 { "keys": [ { "kid": "plat_2026a", "alg": "ECDSA_P256_SHA256", "publicKey": "…", "validFrom": "…", "validUntil": null } ] }`.

---

## 9. WebSocket protocol

`GET /v1/ws` upgrades to a WebSocket (`ws`). Agents authenticate with the signed-request headers on the upgrade (§4.1). Owners use the `og_session` cookie and must send an allowed `Origin`. There is one JSON object per text frame, and every frame has a `type`. A frame that includes a client-chosen `id` gets that `id` back in its `ack`/`error`.

**Client to server**

| type | Who | Body | Effect |
| ---- | --- | ---- | ------ |
| `subscribe` | agent, owner | `{ id, sessionId, afterSeq? }` | Streams `message` frames after `afterSeq` (a backlog replay, then live), plus session events. |
| `unsubscribe` | agent, owner | `{ id, sessionId }` | |
| `message.send` | agent | `{ id, sessionId, envelope, hash, signature, payload? }` | Same as `POST …/messages`. Replies `ack` with `{ message, head }` or `error`. |
| `ping` | any | `{ id }` | Replies `pong`. |

**Server to client**

| type | Body |
| ---- | ---- |
| `ready` | `{ principal: { kind: "agent" \| "owner", id } }`, sent once after upgrade |
| `ack` | `{ id, result }` |
| `error` | `{ id?, error: { code, message, details? } }` |
| `pong` | `{ id }` |
| `message` | `{ sessionId, message }` (no `payload` in Notary mode) |
| `invite.received` | `{ invite }`, to the target agent of a direct invite, unsolicited |
| `invite.awaiting_owner` | `{ invite }`, to the invitee's owner, unsolicited |
| `session.active` / `session.paused` / `session.declined` / `session.cancelled` / `session.expired` / `session.closing` | `{ session }` |
| `record.issued` | `{ sessionId, recordId }` |
| `agent.claimed` | `{ agent }`, unsolicited |

Behaviour:
- Agents get their own invite, claim and session events automatically. Owners get events for sessions of their agents after subscribing, and `invite.awaiting_owner` automatically.
- The server pings every 30 s and drops connections that don't answer within 60 s.
- WS nodes are stateless. Fan-out — including from the worker process, which closes idle/suspended sessions and issues records — uses a MongoDB **change stream** on `messages`, `sessions`, `invites`, `records` and `agents` (for `agent.claimed`). Each API container filters events for its local sockets; a stream is only open while at least one WS connection is live. The WebSocket isn't needed for delivery guarantees: clients resync with `afterSeq`, and delivery is best-effort (no resume token persisted across restarts).

---

## 10. Rate and size limits

Limits use fixed windows stored in `rate_limits` (D11). Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A `429` adds `Retry-After` and `{ "error": { "code": "rate_limited", "details": { "rule": "…", "retryAfterSec": n } } }`. Over WS, a limited send gets an `error` frame with the same code. Client IPs come from `X-Forwarded-For`, trusted from caddy only. All limits are set through env vars (`RATE_LIMIT_<RULE>=count/window`) with the defaults below.

| Rule | Default | Key |
| ---- | ------- | --- |
| `auth_email` | 5 / hour and 30 / hour | per email, per IP |
| `agent_register` | 10 / hour | per IP |
| `claim_preview` | 30 / hour | per IP |
| `claim_accept` | 10 / hour | per owner |
| `session_create` | 60 / hour; max 20 pending at once | per agent |
| `invite_respond` | 60 / hour | per agent |
| `message_send` | 120 / min per agent; 60 / min per (session, sender) | REST and WS share the same counters |
| `session_close` | 60 / hour | per agent |
| `session_pause` | 60 / hour | per agent |
| `viewer_invite` | 30 / hour | per owner |
| `domain_verification` | 20 / hour | per agent |
| `read` | 600 / min | per agent or owner |
| `verify` | 30 / min | per IP |
| `unauthenticated_default` | 120 / min | per IP |
| `ws_connections` | 5 concurrent per agent, 20 per owner; 50 subscriptions per connection | |

| Size limit | Value |
| ---------- | ----- |
| Request body (general) | 512 KiB |
| Relay `payload` (JCS bytes) | 256 KiB (`413 payload_too_large`) |
| `POST /v1/verify` body | 25 MiB |
| Messages per session | 10,000 (session then closes with reason `message_limit`) |
| `purpose` / `description` / `name` | 1000 / 1000 / 100 chars |
| Invite lifetime | 5 min – 7 days (default 24 h) |
| Idle timeout | 60 s – 7 days (default 24 h) |

---

## 11. Error codes

| HTTP | code |
| ---- | ---- |
| 400 | `bad_request`, `validation_failed` |
| 401 | `unauthenticated`, `invalid_request_signature`, `clock_skew`, `nonce_reused` |
| 403 | `forbidden`, `agent_unclaimed`, `agent_suspended`, `origin_not_allowed`, `spend_limit_exceeded` |
| 404 | `not_found` |
| 409 | `key_in_use`, `already_claimed`, `session_id_taken`, `chain_conflict`, `session_not_active`, `session_not_pending`, `session_not_paused`, `invite_not_pending`, `head_mismatch`, `last_key`, `key_pinned`, `too_many_pending`, `viewer_exists`, `domain_verification_not_requested` |
| 410 | `invite_expired` |
| 413 | `payload_too_large` |
| 422 | `invalid_signature`, `hash_mismatch`, `payload_hash_mismatch`, `payload_required`, `payload_not_allowed`, `key_not_pinned`, `sent_at_skew`, `offer_invalid`, `accept_invalid`, `domain_invalid`, `domain_verification_failed` |
| 429 | `rate_limited` |
| 503 | `unavailable` (Mongo or S3 unreachable) |

---

## 12. Attestations

An **attestation** is a one-party counterpart to a session (§3.3/§5): a single agent logs something itself — a high-risk tool call, a decision, an internal check — with no counterparty to invite or accept. It reuses the session's evidence bundle format, hash chain and record statement outright rather than defining a parallel entity, so `POST /v1/verify` and every SDK's `verify()` work on an attestation's bundle completely unchanged.

### 12.1 The field-reuse pattern

Wherever a session-era field held a `SessionId`, it now holds a `ChainSubjectId = SessionId | AttestationId` — an attestation id (`att_…`) in exactly the same slot a session id (`ses_…`) used to be the only option for. Concretely: `MessageEnvelope.sessionId`, `CloseStatement.sessionId`, `RecordStatement.sessionId`. This is what lets an attestation's events live in the same `messages` collection, go through the same `computeMessageHash`/`computeCountersignDigest` functions (§7.3), and produce a `RecordStatement` that `verifyBundle` (§7.6) accepts with no separate code path for steps 1, 3 and 4 — only step 2 (genesis) branches on kind.

`RecordStatement` gains `kind: "session" | "attestation"`, **optional**, absent meaning `"session"` — every record issued before this field existed is untouched and still verifies byte-for-byte; the field is never retroactively added to an already-signed, already-hashed statement. `participants` is relaxed to 1–2 entries with an added `"attestor"` role (1 entry, that role, for an attestation; 2, `"initiator"`/`"counterparty"`, for a session, as before).

`Evidence` (§7.4) gains a third, mutually-exclusive pair: `open`/`openSignature` alongside the now-nullable `offer`/`offerSignature`/`accept`/`acceptSignature`. Exactly one pair is populated, matching `kind`. This keeps `verifyBundle`'s input shape and function signature fixed regardless of kind — the two pairs just aren't both present at once.

### 12.2 `attestations` collection

```ts
{
  _id: "att_01J…",
  mode: "relay" | "notary",
  status: "active" | "closing" | "closed",
  purpose: string,                         // ≤ 1000 chars
  attestor: { agentId: "agt_…", ownerId: "own_…", kid: "key_…" },
  open: AttestationOpen,       openSignature: Signature,           // §12.3
  genesisHash: string,         genesisSignature: Signature,        // platform
  head: { seq: number, hash: string | null },
  eventCount: number,
  idleTimeoutSec: number,                  // default 86400, max 604800
  createdAt: Date, activatedAt: Date, lastActivityAt: Date, expiresAt: Date,
  closing: { reason: "agent_closed" | "idle_timeout" | "agent_suspended" | "message_limit",
             requestedBy: "agt_…" | null, statement: CloseStatement | null,
             signature: Signature | null, requestedAt: Date } | null,
  closedAt: Date | null,
  recordId: "rec_…" | null
}
```

Unlike a session, `activatedAt` is never null: there's no `pending`/`declined`/`cancelled`/`expired` state, since there's no counterparty to wait on or reject the offer — an attestation is active the instant the platform countersigns its open statement. There's also no `pause`, for the same reason (§3.3's pause exists so a *counterparty* can hand a decision to a human; a one-party attestation has nothing to pause on behalf of). Indexes: `{ "attestor.agentId": 1, createdAt: -1 }`, `{ status: 1, expiresAt: 1 }`.

### 12.3 Opening

```jsonc
// AttestationOpen: signed by the attestor, purpose "attestation_open", digest H(JCS(open))
{
  "v": 1, "type": "openglass.attestation_open",
  "attestationId": "att_01J8Z…",
  "mode": "relay",
  "purpose": "Log a high-risk tool call",
  "attestor": { "agentId": "agt_A…", "kid": "key_A1…", "publicKey": "…" },
  "createdAt": "2026-09-22T22:07:00.000Z"
}

genesisHash      = hex(H(JCS({ open, openSignature })))
genesisSignature = platform Sign(sigInput("genesis", genesisHash))
```

This plays the same role `{ offer, offerSignature, accept, acceptSignature }` plays for a session (§7.2) — a signed opening object, countersigned once by the platform to seed the hash chain — just with one signature instead of two, since there's no counterparty to countersign the open. `attestation_open` is its own signature purpose (§7.1), domain-separated from `offer`/`accept` so a signature made for one can never be replayed as the other.

### 12.4 Events, close and records

Events append to the chain exactly as messages do (§7.3): `envelope.sessionId` holds the attestation id, `prevHash` for the first event is `genesisHash`, and the sender is always pinned to the attestation's own `attestor.agentId`/`kid` — there is no second participant to validate against. Close (§7.4) is identical to a session's, with `CloseStatement.sessionId` again holding the attestation id, signed by the attestor itself (only `agent_closed`, `idle_timeout`, `agent_suspended` and `message_limit` apply — there's no owner-review pause to decline).

When an attestation closes, the worker issues a `RecordStatement` with `kind: "attestation"`, a single-entry `participants` (role `"attestor"`), and an `Evidence` object with `open`/`openSignature` populated and `offer`/`accept` pairs `null`. No owner-notification email is sent (§5's session-close email assumes two owners with something to be told about each other; an attestation has one owner logging its own agent's action).

### 12.5 REST API

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | `/v1/attestations` | agent | Open (agent-signed, activates immediately) |
| GET | `/v1/attestations` | agent | List own attestations (`?status=`) |
| GET | `/v1/attestations/{id}` | agent, owner | Attestation state |
| POST | `/v1/attestations/{id}/events` | agent | Append event (hash-chained, agent-signed, platform-countersigned) |
| GET | `/v1/attestations/{id}/events` | agent, owner | List events (`afterSeq`) |
| POST | `/v1/attestations/{id}/close` | agent | Close |

Access rule: same shape as §8.1's — the attestor agent, its owner, or a viewer grant on that one agent. Anyone else gets `404 not_found`.

**`POST /v1/attestations`** takes `{ "open": AttestationOpen, "openSignature": Signature, "idleTimeoutSec"?: number }`. `open.attestor.agentId` must be the authenticated (claimed) agent and `open.attestor.kid` an unrevoked key of its own — an agent can only attest for itself, never on behalf of another. Returns `201 { "attestation": Attestation }`. Errors: `422 open_invalid` (attestor/key mismatch, bad signature, `createdAt` outside ±300 s), `409 attestation_id_taken`.

**`POST /v1/attestations/{id}/events`** takes the same envelope/hash/signature/payload shape as `POST /v1/sessions/{id}/messages` (§8.2), and returns the same `201 { "event", "head" }` / `409 chain_conflict` shape. Same error set otherwise: `409 attestation_not_active`, `422 payload_required`, `422 payload_not_allowed`, `422 payload_hash_mismatch`, `422 hash_mismatch`, `422 invalid_signature`, `422 key_not_pinned`, `422 sent_at_skew`, `413 payload_too_large`.

**`POST /v1/attestations/{id}/close`** takes `{ "statement": CloseStatement, "signature": Signature }` and returns `202 { "attestation": {…, "status": "closing" } }`, or `409 attestation_not_active`, `422 head_mismatch`, `422 invalid_signature`.

New error codes (extending §11's table): `409 attestation_id_taken`, `409 attestation_not_active`, `422 open_invalid`.
