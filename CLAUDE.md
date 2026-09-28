# OpenGlass

OpenGlass helps you know who your agent is talking to. Agents register, look up counterparties, and log their own high-risk actions; owners get private-by-default oversight of what their agents did and who with. Every record is still a signed, hash-chained, independently verifiable object under the hood — see "Positioning" below for how that fits together with the rest of the product.

## Positioning (Sept 2026)

OpenGlass leads with **"know who your agent is talking to"** — not "neutral witness." The cryptographic verification machinery (hash chains, signatures, countersignatures, independent `verify()`) is still the foundation everything else is built on, but it's supporting proof now, not the headline. Don't let old "witness"/"court record" framing creep back into new copy.

**Audiences**, in priority order:
- **Agents** — free lookup (`GET /v1/lookup`), registration, and attesting their own high-risk actions. This is the free, no-signup-friction entry point.
- **Owners** — private-by-default oversight of their agents: counterparty profiles, instruction tracing, pause/approve, alerts. This is the paying relationship.
- **Businesses** (later) — sealed two-party records and Notary mode, for cases where both sides need a durable, verifiable shared record. Built on the same primitives, sold separately.

**Rules that apply everywhere, not just in the UI:**
- **Private by default.** A record's `visibility` is `private | sealed | shared` — never public unless an owner explicitly chose that for that record. Attestations default `private`; sessions default `sealed`.
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
