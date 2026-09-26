# OpenGlass

A neutral witness for agent-to-agent interactions. See [`docs/SPEC.md`](docs/SPEC.md) and [`CLAUDE.md`](CLAUDE.md).

## Run locally

```sh
docker compose up --build -d --wait
curl -k https://localhost/health     # {"status":"ok","checks":{"mongo":"ok","s3":"ok"}}
```

Caddy serves `https://localhost` with a certificate from its internal CA. `-k` skips verification. To trust the CA instead:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
curl --cacert caddy-root.crt https://localhost/health
```

| Service | URL | Notes |
| ------- | --- | ----- |
| web | https://localhost/ | Next.js |
| api | https://localhost/health, `/v1/*` | Fastify. Runs `migrate` on every start. |
| mcp | https://localhost/mcp | |
| mongo | `mongodb://localhost:27017/openglass?directConnection=true` | `mongo:7`, single-node replica set `rs0` |
| minio | http://localhost:9001 (console) | bucket `openglass-records`, Object Lock on. User `openglass` / `openglass-dev-secret`. |
| mailpit | http://localhost:8025 | Catches all outgoing email |

MinIO no longer publishes official images, so compose uses the maintained community build [`pgsty/minio`](https://hub.docker.com/r/pgsty/minio), pinned to a release.

## See it in action

[`examples/witnessed-negotiation`](examples/witnessed-negotiation) is a runnable, end-to-end demo: two agents register, get claimed, negotiate a purchase order over a witnessed session, close it, and independently verify the resulting record — against the real API, not a mock. See [`examples/README.md`](examples/README.md).

## Risk policy

[`/spec/openglass-policy`](spec/openglass-policy) is a small, versioned, vendor-neutral YAML format for classifying an agent's action as `low`/`medium`/`high` risk — deciding *when* an action is worth a witnessed record, separate from the attestation mechanism itself (`docs/SPEC.md` §12). Reference evaluators: [`core-js`](core-js) (`@openglass/core`) and [`core-py`](core-py) (`openglass-core`), kept in sync by a shared set of test vectors. See [`docs/POLICY.md`](docs/POLICY.md) for the guide.

## Integrations

[`otel-js`](otel-js)/[`otel-py`](otel-py) (`openglass-otel`) plug into an already-OpenTelemetry-instrumented agent: a `SpanProcessor` reads GenAI spans, classifies each against an `openglass-policy`, and opens an attestation for the risky ones — no OpenGlass-specific code in the agent itself. See [`examples/otel-integration`](examples/otel-integration) for a runnable demo. [`/integrations/_template`](integrations/_template) is the starting point for a framework-specific integration, including the conformance tests every integration must pass.

## Develop and test

```sh
corepack enable
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test          # starts a throwaway mongo:7 container (needs Docker)
```

### Same tests, different MongoDB

The database is configured by `MONGODB_URI` and nothing else. With `MONGODB_URI` unset, the tests start a throwaway `mongo:7` container. With it set, they run against that server instead. Each test file uses its own `og_test_<random>` database and drops its collections afterwards.

```sh
# the local compose Mongo
MONGODB_URI='mongodb://localhost:27017/openglass?directConnection=true' pnpm -r test

# an Atlas free-tier cluster: only the URI changes
MONGODB_URI='mongodb+srv://<user>:<password>@<cluster>.mongodb.net/openglass?retryWrites=true&w=majority' pnpm -r test
```

For the Atlas run:
- The database user needs `readWriteAnyDatabase` and `dbAdminAnyDatabase`. Tests create per-file databases, and `migrate` runs `collMod` to set validators.
- Your IP must be on the cluster's access list.

The production app user only needs `readWrite` and `dbAdmin` on the `openglass` database.

### Schema changes

- Collections are defined in [`packages/db/src/models`](packages/db/src/models). Each has a Zod model, a `$jsonSchema` validator generated from that model, and named indexes. `migrate` applies all of them idempotently on api start, under a lock.
- Data changes go in versioned scripts: `pnpm --filter @openglass/db migration:create <name>`, which writes to `packages/db/migrations`.

## Deploy

`main` is built, pushed to ECR and deployed to a single EC2 instance by [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The AWS resources and first-time setup are in [`infra/README.md`](infra/README.md).
