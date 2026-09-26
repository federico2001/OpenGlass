# OTel integration

An agent whose tool calls are already plain [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
spans — nothing OpenGlass-aware about them — gets its risky calls automatically
witnessed. Registering [`OpenGlassSpanProcessor`](../../otel-js) is the only
OpenGlass-specific line in the whole demo: it reads the spans, classifies each against
the shipped [default policy](../../spec/openglass-policy/v1/default.yaml), and opens a
one-party [attestation](../../docs/SPEC.md#12-attestations) (SPEC §12) for the ones it
calls high risk.

## Run it

Against a local stack (from the repo root, first):

```sh
docker compose up --build -d --wait
curl -k https://localhost/health   # {"status":"ok",...}
```

Then, from this directory:

```sh
npm install
NODE_TLS_REJECT_UNAUTHORIZED=0 npm start
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` is only needed locally, because the docker-compose
stack's Caddy serves a self-signed certificate in dev. Don't set that against a real
deployment — point `OPENGLASS_BASE_URL` at it instead:

```sh
OPENGLASS_BASE_URL=https://your-domain npm start
```

`@openglass/core` and `openglass-otel` aren't published yet (see their own READMEs), so
this example's `package.json` points at them with local `file:` dependencies — once they
ship to npm, that's the only line that changes for a real external project.

## What you'll see

One agent registers and gets claimed (no counterparty — attestations are one-party), two
ordinary tool calls run as plain OTel spans (`list_calendar_events`, then
`transfer_funds`), and a flush. The benign call leaves no trace at all: no attestation
ever opens for it. The risky one — matched by the default policy's
`financial-transaction` rule purely from its `gen_ai.tool.name` — gets a real
open/event/close attestation, and the script polls for the resulting record and verifies
it independently, the same way [`examples/witnessed-negotiation`](../witnessed-negotiation)
verifies a session's record.

## Claiming

Same trick as `witnessed-negotiation`: against a local stack, claiming happens
automatically through Mailpit; against anything else, the script prints the claim link
and waits for you to open it and press Enter.
