# openglass-otel

An OpenTelemetry `SpanProcessor` that reads [GenAI semantic-convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
spans, classifies each against an [`openglass-policy`](../spec/openglass-policy), and
opens an [OpenGlass attestation](../docs/SPEC.md#12-attestations) for the risky ones —
zero code changes to an already-OTel-instrumented agent, beyond registering the
processor.

Built on [`@openglass/core`](../core-js): the policy evaluation, retry, and fail-open
behavior are `@openglass/core/attest`'s; this package is just the OTel-specific
span-to-event mapping and batching on top.

## Quickstart

```ts
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { OpenGlassSpanProcessor } from "openglass-otel";
import { loadOrCreateIdentity } from "@openglass/core/attest";
import { loadPolicy } from "@openglass/core/policy";
import { readFileSync } from "node:fs";

const identity = loadOrCreateIdentity("./openglass-identity.json");
const policy = loadPolicy(readFileSync("default.yaml", "utf8"));

const provider = new BasicTracerProvider({
  spanProcessors: [new OpenGlassSpanProcessor({ identity, policy })],
});
provider.register(); // or wire into your existing NodeTracerProvider/NodeSDK setup
```

Any span your instrumentation already emits with `gen_ai.*` attributes (tool name,
operation name, etc.) is picked up automatically. A span that ends in error and wasn't
tagged with `error.type` directly gets one synthesized from the span's own status, so the
default policy's error-adjacent rules still fire.

## Batching

`onEnd` only enqueues a span (`SpanProcessor.onEnd` is synchronous by contract); actual
policy evaluation and attestation calls happen on `scheduledDelayMs` (default 5000ms) or
immediately via `processor.forceFlush()` — so a slow OpenGlass API never blocks span
processing, on top of `evaluateAndAttest`'s own per-call fail-open behavior.

## Mapping your own fields in

Pass `extractEvent` to add fields beyond the OTel GenAI attributes:

```ts
new OpenGlassSpanProcessor({
  identity,
  policy,
  extractEvent: (span) => ({
    attributes: span.attributes,
    fields: { amountUsd: span.attributes["myapp.amount_usd"] },
  }),
});
```

## Conformance

This package's own test suite (`test/conformance.test.ts`) runs the shared
`@openglass/core/testing` conformance checks against its real span-processing pipeline —
the same checks any other integration (see [`integrations/_template`](../integrations/_template))
should run against its own event mapping.

## Develop

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm build
pnpm test
```
