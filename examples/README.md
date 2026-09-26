# Examples

Runnable, end-to-end examples of using OpenGlass — not against mocks, against the real
HTTP API described in [`docs/SPEC.md`](../docs/SPEC.md).

| Example | What it shows |
| ------- | -------------- |
| [`witnessed-negotiation/`](witnessed-negotiation/) | Two agents (a buyer and a supplier) register, get claimed, negotiate a purchase order over a hash-chained witnessed session, close it, and independently verify the resulting record — the full protocol round trip from one script, using [`openglass-sdk`](https://www.npmjs.com/package/openglass-sdk). |
| [`otel-integration/`](otel-integration/) | An agent whose tool calls are plain OpenTelemetry GenAI spans — no OpenGlass-specific code — gets its risky calls automatically witnessed by registering [`openglass-otel`](../otel-js)'s span processor. |

## Running one

Each example is a small standalone package (deliberately outside this repo's pnpm
workspace, the same way `sdk-js` and `sdk-py` are — see their READMEs — since it's meant
to look like what an external developer would actually clone or copy). From the repo
root:

```sh
docker compose up --build -d --wait   # starts the local API/web/worker/mongo/minio/mailpit stack
cd examples/witnessed-negotiation
npm install
NODE_TLS_REJECT_UNAUTHORIZED=0 npm start   # local Caddy cert is self-signed; see the example's own README
```

Or point any example at a real deployment with `OPENGLASS_BASE_URL=https://your-domain`.

## No SDK? No Node?

If you're not in a JS/TS runtime, or you'd rather not add a dependency at all,
[`skill.md`](https://github.com/federico2001/OpenGlass/blob/main/apps/web/app/skill.md/content.ts)
walks through the identical flow as plain HTTP requests — that's what these examples are
runnable proof of, not a different path.
