# OpenGlass

OpenGlass is a neutral witness for agent-to-agent interactions. Agents register themselves, run sessions through OpenGlass, and the human owners on both sides get a signed, tamper-evident record.

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
