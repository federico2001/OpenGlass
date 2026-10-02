# Friction log: building Agent Checkup on OpenGlass

One line per moment the OpenGlass API, SDK or dashboard was confusing or missing something while building `apps/checkup`, as an outside developer would hit it. **Fixed** means fixed in the same change; **Open** means still there.

## API

- **Fixed.** Lookup of an unregistered domain only tried `/.well-known/agent.json`, the pre-0.3 A2A path. Current agents publish `/.well-known/agent-card.json`, so lookup reported "no card" for them. It now tries `agent-card.json` first, then `agent.json`.
- **Fixed (minimal).** There was no way to give an agent that never heard of OpenGlass a profile. Registration needs the agent's own key, and nothing else existed. Added unclaimed profiles (`POST /v1/profiles/unclaimed`, `GET /v1/profiles/unclaimed/{domain}`, `unclaimedProfile` in lookup, docs/SPEC.md §16), claimed through ordinary domain verification.
- **Fixed.** `GET /v1/lookup` cached a "not registered" answer for 60 seconds, even for `publicKey` lookups. So a service that registered and then restarted looked itself up and was told it didn't exist. It then tried to register again and got `409 key_in_use`. Misses by `agentId`/`publicKey` are no longer cached.
- **Fixed.** Even after that fix, lookup kept serving its 60-second cached answer for a domain. A domain the checkup had just listed as an unclaimed profile read as "no profile" in lookup, and on its OpenGlass page, for up to a minute. Cache hits now re-read the profile.
- **Open.** Attestations share the `session_create` rate limit: 60 per hour per agent. A service that records one attestation per action (here, one per checkup) is capped at 60 actions an hour. Past that, `POST /v1/attestations` returns 429. There's no per-agent override and no documented way to ask for more. The checkup degrades to "not recorded" with the reason.
- **Open.** Records are never public, and there's no first-party "share this record" link or public bundle page. To give a report a public verification link, the agent has to fetch its own bundle with its own key and republish it (`/r/{id}/bundle.json` here). That's consistent with the rules, but nothing in the docs suggests this pattern.
- **Open.** Record issuance is asynchronous: the worker issues the record after close. An agent that closes an attestation has no record id yet and has to poll `GET /v1/attestations/{id}` until `recordId` appears. There's no webhook or "record issued" event.

## SDK (`openglass-sdk` 0.2.0 from npm)

- **Open.** No way to restore an identity from a stored key. To restart, a service has to:
  1. derive the public key itself;
  2. `lookup({ publicKey })` to get the agent id;
  3. `getAgent()` to find which `kid` that key has;
  4. assemble an `AgentIdentity` by hand.

  A `fromPrivateKey()` helper, or identity (de)serialization, would remove all of this. The private-key format (a raw 32-byte Ed25519 key) isn't documented either.
- **Open.** The SDK doesn't export its request signer. Calling any route it doesn't wrap means reimplementing SPEC §4.1 signing from the exported primitives (`canonicalize`, `sha256`, `sigInput`, `signEd25519`). That applies to `POST /v1/agents/me/claim-token` and the new unclaimed-profile routes.
- **Open.** There's no method for `POST /v1/agents/me/claim-token`. Claim links expire after 24 hours, and a service whose owner missed that window has no SDK way to get a new one.
- **Open.** The published 0.2.0 lags `main`. It doesn't have the `send_message` re-chaining fix, and its `LookupResult` type has no `unclaimedProfile`. Types are generated from the OpenAPI file at release time, so new API fields need a cast until the next release.
- **Open.** Errors from the unauthenticated calls (`lookup`, `getAgent`, `fetchTrustedKeys`) are thrown as `OpenGlassApiError` with `status: 0`. A rate limit (429) can't be told apart from a bad request (400) without parsing the body.
- **Open.** It isn't obvious that you need `visibility: "shared"` to hand out an offline-verifiable attestation bundle. The default is `private`, and on a server with content encryption, `private` makes the bundle's evidence ciphertext. The readable `decryptedPayloads` sits outside what the signatures cover. The SDK docs say what each visibility means, not which one to pick for this use.
- **Open.** `sendAttestationEvent` tracks the chain head in process memory only. After a crash mid-attestation there's no automatic recovery: you have to read the head from `getAttestation` and pass `seq`/`prevHash` yourself. Sessions got that recovery in #41.
- **Open.** `waitForAttestationRecord` has no default timeout, so a call with no options can block forever if the worker is down.

## Onboarding and dashboard

- **Open.** Claiming needs a human owner signed in through an email magic link. That's by design, but the deploy docs never say a newly deployed service sits unclaimed (and records nothing) until someone opens its claim link. Here the admin page shows the link and can mint a new one.
- **Open.** There's no dashboard view of an agent's attestation rate-limit usage, or of failed attestation attempts. From the owner's side, "recording stopped" is invisible.
