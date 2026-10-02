# Agent Checkup by OpenGlass

An A2A agent that checks other A2A agents from the outside, served at `https://checkup.<domain>` (production: `https://checkup.openglass.glass`). It's also a working example of an agent using OpenGlass the way any outside developer would: the published `openglass-sdk`, over HTTP, never the database. [`FRICTION.md`](FRICTION.md) logs everything that was confusing or missing along the way.

## What it does

Send it an agent-card URL or a domain:

- over A2A JSON-RPC at `/a2a`, with `message/send` (A2A 0.3) or `SendMessage` (A2A 1.0);
- or through the form at `/`.

| Section | Checks |
| --- | --- |
| Card | Fetches the given URL, or both `/.well-known/agent-card.json` and `/.well-known/agent.json`. Validates against the A2A 1.0 schema (0.3 for legacy cards) and lists missing or weak fields: short descriptions, skills without examples, no provider. |
| Endpoint | One benign test message to the card's JSON-RPC (or HTTP+JSON) interface, in that interface's protocol version. Records success, latency and any error. |
| x402 | If the card claims x402, that same unpaid message must come back asking for payment, in one of two ways: a well-formed HTTP 402 (x402 v2 `PAYMENT-REQUIRED` header, or a v1 JSON body), or an A2A x402 `payment-required` task. |
| Identity | Public signals only: the domain resolves, the TLS certificate is valid, the card has provider fields, and the agent is listed in the A2A Registry (with uptime, via its public API). |

The reply is a short plain-language report with a 0–100 score per section and the top three fixes. The same report is also attached as JSON: a `data` part over A2A, `/r/{id}.json` on the web.

## OpenGlass wiring

- **Identity.** On start, the service looks itself up by public key, or registers. Until its owner claims it, `/admin` shows the claim link and can mint a new one.
- **Records.** Each fresh checkup is a one-party attestation (visibility `shared`, so the bundle verifies offline) with these events:
  1. `checkup.request_received`;
  2. one `checkup.check_result` per section;
  3. `checkup.report_issued`, carrying the report's hash.
- **Verification link.** Each report links to `/r/{id}/bundle.json`. That's the checkup's own record bundle, which it fetches with its own key once the worker has issued the record. Verify it offline with `openglass-sdk`'s `verifyBundle()`.
- **Target profile.** Each checkup also looks the target's domain up on OpenGlass:
  - Unregistered domains are listed as unclaimed profiles (docs/SPEC.md §16), and the report says so in one line: `OpenGlass profile: unclaimed — claim it to add a verified domain: <link>`. The link is a counted redirect to the claim page.
  - Registered domains get a line linking to their profile.

## Safety

- **SSRF.** Every outbound connection resolves the host itself and refuses private, loopback, link-local, CGNAT and reserved addresses. The connection goes to the exact address that was checked. Redirects are followed only when fetching cards, and each hop is re-checked (POSTs never follow redirects).
- **Limits.** Every request has a 10-second timeout. Bodies are capped: 128 KiB for cards, 256 KiB for responses.
- **Rate limits.** 20 fresh checks per caller per hour (120 cached ones). 6 fresh checks per target host per hour. Results are cached for an hour.
- **Target content is data.** The target's card and replies are only parsed and scored. Nothing in them is followed or executed. Target text is escaped in pages and bounded in the text report.

## Metrics

`/admin` (HTTP Basic, password `CHECKUP_ADMIN_TOKEN`) shows the following for 24 h, 7 d, 30 d and all time:
- checks run, with A2A Registry probes counted separately by their `A2A-Registry-*` user-agent;
- cache hits;
- unique targets;
- report-link opens;
- claim-link clicks;
- unclaimed profiles listed;
- registrations from claims: clicked domains whose profile has since been claimed.

## Configuration

| Variable | |
| --- | --- |
| `MONGODB_URI` | Its own `checkup_*` collections, migrated by the api. |
| `CHECKUP_PUBLIC_URL` | e.g. `https://checkup.openglass.glass` |
| `OPENGLASS_API_URL` | `http://api:3000` inside Docker |
| `OPENGLASS_PUBLIC_URL` | e.g. `https://openglass.glass` |
| `CHECKUP_AGENT_PRIVATE_KEY` | 32-byte Ed25519 key, base64url. Generate once: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `CHECKUP_ADMIN_TOKEN` | At least 16 characters. |
| `A2A_REGISTRY_URL` | Default `https://a2aregistry.org`. |
| `CHECKUP_ALLOW_PRIVATE_TARGETS` | Tests only. |

## Run and ship

- **Local stack.** `docker compose up --build -d --wait`, then open `https://checkup.localhost`. Claim the agent at `https://checkup.localhost/admin`; the dev password is in `docker-compose.yml`. Without a claim, checkups run but aren't recorded.
- **Tests.** `pnpm --filter @openglass/checkup test`. These run the real OpenGlass API in-process against a fake A2A target and a fake A2A Registry, with throwaway Mongo and MinIO.
- **Production.** Set the two secrets as SSM SecureStrings (see infra/README.md), deploy, then claim the agent from `/admin`.
- **A2A Registry.** Register and wait for "reachable" and "task-verified":
  ```sh
  node apps/checkup/scripts/register-a2a-registry.mjs https://checkup.openglass.glass
  ```
