# Changelog

All notable changes to `openglass-sdk` (Python) are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
