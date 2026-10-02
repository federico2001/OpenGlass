# Changelog

All notable changes to `openglass-sdk` (Python) are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Fixed

- `send_message()` works in a real back-and-forth conversation. It used to track only the chain
  head from this client's own sends, so the first send after the other agent's message was
  rejected with `409 chain_conflict`, and the initiator couldn't send before calling
  `wait_for_active()`. It now reads the head from the session when it doesn't know it, and on
  `chain_conflict` re-chains onto the head the server reports and retries (up to
  `retry_on_conflict`, default 3; docs/SPEC.md §5.3, D8). Explicit `seq`/`prev_hash` is never retried.
- Server-side: a `private` request the platform can't satisfy (no content encryption
  configured) now falls back to `shared` (same readers, content kept) instead of `sealed`.

### Changed (server-side, no client code change)

- Sessions now default to `visibility: "shared"` on the server: both participant owners can
  read the full record from the moment it's issued. `"sealed"` is deprecated for new records;
  it's still accepted when passed explicitly, so existing callers keep working.
- `POST /v1/records/{id}/dispute` now flags any two-party record as disputed instead of only
  force-unsealing sealed ones. Record responses carry a new `dispute` field.
- Docs: `dispute()`, `request_unseal()` and `approve_unseal()` call owner-authenticated routes,
  so an agent-signed call returns 401. Documented, not yet fixed.

## 0.2.0

Realignment R7 — "know who your agent is talking to."

### Added

- `client.lookup(agent_id=None, domain=None, agent_card_url=None, public_key=None)` —
  `GET /v1/lookup`, public, no auth.
- `client.request_domain_verification()` / `client.verify_domain()` — the domain-verification
  request/check round trip.
- Attestations: `open_attestation()`, `get_attestation()`, `send_attestation_event()`,
  `close_attestation()`, `wait_for_attestation_record()` — the one-party counterpart to a
  session, previously unsupported by this client.
- `visibility` keyword on `offer_session()` and `open_attestation()`
  (`"private" | "sealed" | "shared"`, docs/SPEC.md §13).
- Sealed record ceremony: `request_unseal()`, `approve_unseal()`, `dispute()`.
- `client.guard(risk, counterparty_agent_id, ...)` — a pre-flight counterparty check for actions
  your own policy layer flags as risky, allow/warn/block per locally-configured policy, fails
  open if OpenGlass is unreachable.

### Changed

Nothing — every 0.1.x method keeps its existing signature and behavior. `offer_session`'s
`visibility` is optional and still defaults to `"sealed"`.

## 0.1.0

Initial release: `register_agent`, session offer/accept/message/close, `verify`/`verify_bundle`,
`witness()`.
