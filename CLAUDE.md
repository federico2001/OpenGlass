# OpenGlass

OpenGlass is a neutral witness for agent-to-agent interactions. It sits between agents and favors neither: agents register, look up counterparties before they act, log their own high-risk actions, and run sessions through OpenGlass, and the human owners on both sides get the same signed, hash-chained, independently verifiable record. See "Positioning" below for how the pieces fit together.

## Positioning (revised Oct 2 2026)

OpenGlass **is a neutral witness** for agent-to-agent interactions. Public copy (landing page, `/agents`, site metadata, llms.txt) leads with the witness and only the witness: it doesn't sell identity, "we verify" or "we look up", which overlaps with what A2A agent registries already do and dilutes the message. Lookup, domain verification and profiles still exist and stay documented as reference features, just not as the pitch. Don't drift into "court record"/legal-team framing either: the witness is neutral infrastructure, not an arbiter. The cryptographic machinery (hash chains, signatures, countersignatures, independent `verify()`) is what makes the witness trustworthy without trusting the operator. The public directory finds an agent by its ID only.

**Audiences**, in priority order:
- **Agents** — free lookup (`GET /v1/lookup`), registration, and attesting their own high-risk actions. This is the free, no-signup-friction entry point.
- **Owners** — oversight of their agents, never public: counterparty profiles, instruction tracing, pause/approve, alerts. This is the paying relationship.
- **Businesses** (later) — durable two-party records, Notary mode, and the tooling around them, for cases where both sides need a verifiable shared record they'll rely on for years. Built on the same primitives, sold separately.

**Rules that apply everywhere, not just in the UI:**
- **Never public; both sides see the same record.** A record's `visibility` is `shared | private` (plus the deprecated `sealed`); none of them makes a record public. Attestations default `private` (only the attesting agent's owner). Sessions default `shared`: both participant owners read the full record from the moment it's issued, because a witness's record is only useful if both sides hold the same one, and the counterparty's agent already saw every message anyway. `sealed` (receipt-only until both owners unseal) is deprecated for new records: still accepted when a caller passes it explicitly, never a default, never offered in UI or copy. Don't reintroduce withhold-until-consent mechanics.
- **Disputes are flags, not keys.** Either participant owner can dispute a two-party record once; it's recorded, emailed to the other owner and counted on profiles, but it changes and opens nothing (except a legacy sealed record, which it still force-unseals, the rule that record was issued under).
- **Retention is owner-chosen for private records** (30 days / 1 year / custom), enforced by crypto-shredding (destroy the per-record data key, not the record) — never a raw delete of an append-only document. Sealed and shared records keep full-duration S3 Object Lock, since their whole point is a durable proof both sides can rely on.
- **Profiles show verifiable facts only** — activity counts, verified domain, first-seen date, key age, dispute count. Never ratings, reviews, or session content. If it can't be independently verified from something the platform or a DNS record actually attests to, it doesn't go on a profile.
- **Agent-facing copy must be accurate and must never instruct agents to always call OpenGlass.** State what a tool/endpoint is for and let the calling agent (or its owner's `openglass-policy`) decide when to use it.
- **Records already issued under COMPLIANCE-mode Object Lock are never touched, retroactively reclassified, or deleted.** This visibility/retention model governs new records only — existing guarantees don't change under anyone.

## Stack

TypeScript monorepo using pnpm workspaces:

| Path           | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `/apps/api`    | HTTP + WebSocket API (Fastify + `ws`)               |
| `/apps/mcp`    | MCP server                                          |
| `/apps/worker` | Background jobs                                     |
| `/apps/web`    | Web UI (Next.js)                                    |
| `/packages/db` | Zod models, MongoDB client, migrations              |
| `/sdk-js`      | JavaScript/TypeScript SDK                           |
| `/sdk-py`      | Python SDK                                          |
| `/core-js`     | `@openglass/core` — reference `openglass-policy` evaluator + attestation client (TS) |
| `/core-py`     | `openglass-core` — reference `openglass-policy` evaluator + attestation client (Python) |
| `/otel-js`     | `openglass-otel` — OpenTelemetry GenAI `SpanProcessor` integration (TS) |
| `/otel-py`     | `openglass-otel` — OpenTelemetry GenAI `SpanProcessor` integration (Python) |
| `/langchain-py` | `openglass-langchain` — LangChain `BaseCallbackHandler` integration (Python) |
| `/integrations` | Adapter skeleton + conformance tests for building a new integration |
| `/spec/openglass-policy` | Versioned YAML risk-policy format + JSON Schema, vendor-neutral |
| `/infra`       | AWS CDK stack (ECR, EC2, S3, KMS, Route 53, SES, SSM, budget) |
| `/deploy`      | `deploy.sh`, run on EC2 through SSM Run Command     |

## Running

Everything runs in Docker. `docker compose up --build -d --wait` then `curl -k https://localhost/health`. Develop with `pnpm install && pnpm -r build && pnpm -r test`. See README.md for details and infra/README.md for AWS.

- `docker-compose.yml`: local development. Runs api, mcp, worker, web, `mongo:7` (as a single-node replica set), minio, mailpit and caddy.
- `compose.prod.yml`: production on EC2.

Containers are stateless. Keep persistent state in MongoDB or object storage (S3/minio), never on the container filesystem.

## Configuration

All config comes from env vars. Never branch code on environment (no `if (NODE_ENV === 'production')` style logic). Pick behavior from explicit config values instead.

- `MONGODB_URI`: the only difference between local Mongo and Atlas.
- `S3_ENDPOINT`: object storage (minio locally, S3 in prod).
- `SIGNER=local|kms`: platform signer implementation.
- `EMAIL=smtp|ses`: email transport (mailpit via SMTP locally).

## Database

MongoDB via the official Node.js driver.

- Every collection has:
  1. a Zod model in `/packages/db`,
  2. a `$jsonSchema` validator,
  3. indexes.

  The validator and indexes are applied by an idempotent migrate step that runs on startup.
- Data changes go in versioned scripts in `/packages/db/migrations` (migrate-mongo).
- Never ask a human to edit the database by hand. If data needs to change, write a migration.
- The `messages` and `records` collections are **append-only**. Never update or delete documents in them.

## Integrity model

Every message:

1. is hash-chained: `hash = sha256(previousHash + canonicalJSON(message))`,
2. is signed by the sending agent's Ed25519 key,
3. is countersigned by the platform signer (`SIGNER`).

Keep all three when changing message handling. Always use the shared canonical JSON serializer when computing hashes, never `JSON.stringify` directly.

## Design

UI follows the Clear Channel design system: docs/DESIGN.md (source: docs/brand/clear-channel.html). Use the tokens in apps/web/app/tokens.css, never raw hex. Use Manrope for display/body, Fragment Mono for machine data (hashes, IDs, requests), and IBM Plex Mono for labels. Use the `TwinPane` component for the logo. Keep text at WCAG AA contrast in light and dark. Fonts are self-hosted, so no third-party requests.

## Testing

Write tests for every route. Tests run against a throwaway Mongo container. Don't mock the database, and don't point tests at a shared instance.
