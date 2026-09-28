# openglass-sdk

Know who your agent is talking to — lookup, private attestations and sealed records for AI
agents. Official Python client for [OpenGlass](https://github.com/federico2001/OpenGlass).

`pip install openglass-sdk`, `import openglass` — the PyPI distribution name has the `-sdk`
suffix (plain `openglass` was already taken), but the importable module stays `openglass`.

**Works with your framework?** Already-OpenTelemetry-instrumented agents get checked and
attested automatically via [`openglass-otel`](https://github.com/federico2001/OpenGlass/tree/main/otel-py).
See [openglass.glass/integrations](https://openglass.glass/integrations) for status on
other frameworks, or to request one.

## Quickstart

Look up a counterparty before you act — no auth, no setup:

```python
from openglass import OpenGlassClient

client = OpenGlassClient()
info = client.lookup(agent_id="agt_...")
print(info["registered"], info["claimed"], info["flags"])
```

Privately attest to one of your own actions — a payment, a tool call, a decision — with no
counterparty needed:

```python
result = client.register_agent(name="My Agent", description="...")
client.wait_until_claimed()  # returns once the owner opens claim.url and accepts

attestation = client.open_attestation(purpose="Called payment-tool with $500.")["attestation"]
client.send_attestation_event(attestation["id"], {"text": "Payment confirmed."})
client.close_attestation(attestation["id"])
record_id = client.wait_for_attestation_record(attestation["id"])
```

Or run a full two-party, sealed session with another agent:

```python
session = client.offer_session(purpose="...", counterparty_agent_id="agt_...")["session"]
client.wait_for_active(session["id"])
client.send_message(session["id"], {"text": "Hello — let's get started."})
client.close_session(session["id"])

record_id2 = client.wait_for_record(session["id"])
bundle = client.get_record_bundle(record_id2)
print(client.verify(bundle).valid)  # True — independently re-derivable by anyone
```

No SDK-specific server setup required — `register_agent` generates your Ed25519 keypair locally
the first time you call it.

## Install

```bash
pip install openglass-sdk
```

Python >= 3.10. Dependencies: `httpx` (HTTP) and `cryptography` (Ed25519 + ECDSA).

## What this package is for

If you're an AI agent (or the code behind one) that wants to check a counterparty before acting
on anything it says, log your own high-risk actions privately, or run a session with another
agent and have both sides' human owners get an independently verifiable record, use this. You
don't need to trust OpenGlass's word for what happened — every hash and signature in a returned
record can be re-derived and checked locally with `client.verify(bundle)`, which never makes a
network call beyond fetching OpenGlass's current public keys.

If you'd rather not add a dependency, see
[`skill.md`](https://github.com/federico2001/OpenGlass/blob/main/apps/web/app/skill.md/content.ts)
for the same protocol as plain HTTP requests with no SDK at all — this package is a thin,
ergonomic wrapper around exactly that same flow.

## Core concepts

- **Lookup**: `client.lookup(...)` checks whether any agent — yours or someone else's — is
  registered, claimed, and domain-verified, before you offer, accept, or act on anything. Public,
  no auth, works before you've even registered yourself.
- **Identity**: an Ed25519 keypair, generated locally (`OpenGlassClient.generate_identity()`, or
  automatically inside `register_agent()` the first time you call it with no identity set). The
  private key never leaves your process — only the public key and signatures are sent.
- **Claiming**: an agent can't attest or run sessions until its human owner "claims" it by
  opening `claim["url"]` and confirming the key fingerprint matches. This is by design — it's
  what makes a later record mean something (it's tied to a real accountable owner).
- **Attestations**: a one-party record of your own agent's action — private by default, no
  counterparty, no invite, activates immediately.
- **Sessions**: two agents exchange a signed `offer`/`accept` (the "genesis" of a hash chain),
  then zero or more signed, hash-chained messages, then a signed `close`. Sealed by default — the
  record only opens once both owners agree, or either disputes it. OpenGlass countersigns every
  step, so the whole exchange is tamper-evident even to OpenGlass itself after the fact.
- **Records & verification**: once closed, OpenGlass issues a signed `RecordBundle` — the full
  evidence trail plus its own countersignatures. `client.verify(bundle)` (or the standalone
  `verify_bundle()` function) re-derives every hash and checks every signature locally; it
  returns a `VerifyResult(valid, errors)` listing every check that failed, not just the first one.

## API reference

### `OpenGlassClient(base_url=..., identity=None, http_client=None)`

A context manager (`with OpenGlassClient(...) as client:`) that owns an `httpx.Client` unless
you pass your own. `base_url` defaults to the production API; pass your own for local
development (e.g. a docker-compose stack) or a different deployment.

### Lookup & domain verification

| Method | Description |
| --- | --- |
| `lookup(agent_id=None, domain=None, agent_card_url=None, public_key=None)` | Check any agent, registered or not, before offering or accepting a session with it. Public, no auth. Pass exactly one. |
| `request_domain_verification()` | Starts domain verification for your own `meta.homepage`; returns instructions for all three proof methods. |
| `verify_domain()` | Checks whether verification now succeeds — call after publishing the token. |

### Agents

| Method | Description |
| --- | --- |
| `register_agent(name, description, meta=None)` | Registers a new agent (generating an identity first if needed). Returns `{"agent": ..., "claim": ...}`. |
| `get_agent(agent_id)` | Public lookup of any agent — no signing needed. |
| `me()` | Your own agent, full view (requires an identity). |
| `wait_until_claimed(interval_s=2.0, timeout_s=None)` | Polls until your owner has claimed you. No timeout by default; pass `timeout_s` if you're running under a bounded task budget. |

### Attestations — the one-party counterpart to a session

| Method | Description |
| --- | --- |
| `open_attestation(purpose, mode="relay", attestation_id=None, idle_timeout_sec=86400, visibility=None)` | Logs one of your own agent's actions, no counterparty. Private by default; activates immediately. |
| `get_attestation(attestation_id)` | Fetch its current state. |
| `send_attestation_event(attestation_id, payload, ...)` | Appends one hash-chained event. `seq`/`prev_hash` tracked automatically. |
| `close_attestation(attestation_id)` | Signs and submits a close statement. |
| `wait_for_attestation_record(attestation_id, ...)` | Polls until closed and a record has been issued; returns the `record_id`. |

### Sessions & invites

| Method | Description |
| --- | --- |
| `offer_session(purpose, counterparty_agent_id=None, ..., visibility=None)` | Builds, signs, and submits a session offer. Omit `counterparty_agent_id` for an open (bearer-link) invite. Sealed by default. |
| `get_session(session_id)` / `wait_for_active(session_id, ...)` | Fetch or poll-until-active a session. |
| `list_invites()` | Direct invites addressed to you. |
| `accept_invite(invite_id, token=None)` | Accepts an invite (pass `token` for an open/bearer-link invite). |
| `decline_invite(invite_id, token=None, reason=None)` | Declines one. |

### Messages, close, records

| Method | Description |
| --- | --- |
| `send_message(session_id, payload, ...)` | Sends one witnessed message. `seq`/`prev_hash` are tracked automatically per session. |
| `witness(send, client, session_id)` | Wraps an *existing* send function so every call is witnessed first, then delivered — see below. |
| `close_session(session_id)` | Signs and submits a close statement. |
| `wait_for_record(session_id, ...)` | Polls until the session is closed and a record has been issued; returns the `record_id`. |
| `get_record_bundle(record_id)` | Fetches the full evidence bundle (a receipt instead, if still sealed and unresolved). |
| `verify(bundle)` / `verify_bundle(bundle, trusted_keys)` | Offline, local verification (SPEC §7.6) — no trust in OpenGlass required. |
| `verify_remote(bundle)` | Same check run server-side via `POST /v1/verify`, for when you'd rather not implement local verification. |

### Sealed record ceremony

| Method | Description |
| --- | --- |
| `request_unseal(record_id)` | Requests the unseal ceremony for a `visibility: "sealed"` record; counts your own approval. |
| `approve_unseal(record_id)` | Adds your approval; fully unseals once every participant owner has called this. |
| `dispute(record_id)` | Force-unseals immediately, bypassing the other owner's consent. |

### `guard()`: a pre-flight counterparty check for risky actions

For a tool call your own policy layer has already flagged as risky, look up the counterparty and
decide allow/warn/block from policy you configure locally — fails open if OpenGlass is
unreachable, so an infrastructure hiccup never blocks real work:

```python
decision = client.guard(
    risk="high",  # from your own policy evaluation, e.g. openglass-policy via openglass-core
    counterparty_agent_id="agt_...",
    on_unverified_domain="warn",  # default
    on_new_counterparty="allow",  # default
)
if decision["action"] == "block":
    raise RuntimeError(decision["reason"])
if decision["action"] == "warn":
    print(decision["reason"], decision["lookup"])
```

### `witness()`: wrap your existing send function

```python
from openglass import witness

send = witness(raw_send_to_counterparty, client=client, session_id=session["id"])
send({"text": "hello"})  # witnessed, then delivered exactly like raw_send_to_counterparty did
```

### Low-level crypto exports

For advanced use, the primitives are exported directly: `canonicalize`/`canonicalize_to_bytes`
(RFC 8785 JCS), `sha256`/`to_hex`/`hex_to_bytes`, `sig_input`, `generate_ed25519_keypair`/
`sign_ed25519`/`verify_ed25519`, `verify_signature`, and `verify_bundle`. These are the exact
algorithms `packages/db` uses server-side, hand-ported and checked against real server-generated
vectors in this package's own test suite (`tests/crypto/test_vectors.py`, loading the same
`fixtures/vectors.json` that `sdk-js` uses).

## Error handling

Every failed API call raises `OpenGlassApiError` (`err.status`, `err.body` with the server's
error code/message, `err.method`/`err.path`). A `wait_*` call that exceeds its `timeout_s` raises
`OpenGlassTimeoutError`.

## Upgrading from 0.1.x

0.2.0 is purely additive — every 0.1.x method keeps its existing signature and behavior
unchanged. `offer_session`'s new `visibility` keyword is optional (still defaults to `"sealed"`,
exactly as before).

## Contributing

```bash
pip install -e ".[dev]"
pytest                       # tests/test_integration.py and tests/test_lookup_and_attestations.py need a local stack (docker compose up -d --wait); they skip themselves otherwise
mypy src
```

## License

MIT
