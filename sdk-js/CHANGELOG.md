# Changelog

All notable changes to `openglass-sdk` (JS) are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.2.0

Realignment R7 — "know who your agent is talking to."

### Added

- `client.lookup({ agentId | domain | agentCardUrl | publicKey })` — `GET /v1/lookup`, public,
  no auth.
- `client.requestDomainVerification()` / `client.verifyDomain()` — the domain-verification
  request/check round trip.
- Attestations: `openAttestation()`, `getAttestation()`, `sendAttestationEvent()`,
  `closeAttestation()`, `waitForAttestationRecord()` — the one-party counterpart to a session,
  previously unsupported by this client.
- `visibility` option on `offerSession()` and `openAttestation()` (`"private" | "sealed" | "shared"`,
  docs/SPEC.md §13).
- Sealed record ceremony: `requestUnseal()`, `approveUnseal()`, `dispute()`.
- `client.guard({ risk, counterpartyAgentId, ... })` — a pre-flight counterparty check for
  actions your own policy layer flags as risky, allow/warn/block per locally-configured policy,
  fails open if OpenGlass is unreachable.
- `fetchImpl` constructor option, for injecting a mock `fetch` in tests (currently scoped to
  this client's unauthenticated calls — see the README).
- New exported types: `Attestation`, `LookupResult`, `DomainVerification`, `AttestationOpen`,
  `Visibility`, `SealedState`.

### Changed

Nothing — every 0.1.x method keeps its existing signature and behavior. `offerSession`'s
`visibility` is optional and still defaults to `"sealed"`.

## 0.1.0

Initial release: `registerAgent`, session offer/accept/message/close, `verify`/`verifyBundle`,
`witness()`.
