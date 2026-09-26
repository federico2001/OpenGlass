# @openglass/core

The reference TypeScript evaluator for [`openglass-policy`](../spec/openglass-policy) — a
small, versioned, vendor-neutral format for classifying an agent's action as `low`,
`medium`, or `high` risk. Standalone package (like [`sdk-js`](../sdk-js)/[`sdk-py`](../sdk-py)),
outside the pnpm workspace, on its own release cadence.

This is the policy piece of what will grow into OpenGlass's integration kit — the
runtime an OpenTelemetry-instrumented app pulls in to decide, per tool call, whether an
action is worth a witnessed record.

## Quickstart

```ts
import { loadPolicy, evaluate } from "@openglass/core/policy";
import { readFileSync } from "node:fs";

const policy = loadPolicy(readFileSync("default.yaml", "utf8"));

const result = evaluate(policy, {
  attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "transfer_funds" },
  fields: { amountUsd: 500 },
});
// { risk: "high", matches: [{ id: "financial-transaction", risk: "high", reasons: [...] }], defaultApplied: false }
```

See [`spec/openglass-policy/README.md`](../spec/openglass-policy/README.md) for the full
format guide (field addressing, operators, versioning) and
[`spec/openglass-policy/v1/default.yaml`](../spec/openglass-policy/v1/default.yaml) for a
ready-to-fork starting policy.

## Attesting a risky event

`@openglass/core/attest` is the primitive every integration (like
[`openglass-otel`](../otel-js)) calls once policy evaluation says an event is risky —
open a one-party [attestation](../docs/SPEC.md#12-attestations), append one event
recording the classified action and its verdict, close it. Fails open by design: an
unreachable API is retried, then reported via `onError`, never thrown — it doesn't block
whatever real action the event describes.

```ts
import { loadOrCreateIdentity, evaluateAndAttest } from "@openglass/core/attest";
import { loadPolicy } from "@openglass/core/policy";
import { readFileSync } from "node:fs";

const identity = loadOrCreateIdentity("./openglass-identity.json"); // generated + persisted on first use
const policy = loadPolicy(readFileSync("default.yaml", "utf8"));

const result = await evaluateAndAttest(identity, policy, {
  attributes: { "gen_ai.tool.name": "transfer_funds" },
  fields: { amountUsd: 500 },
});
// { attested: true, attestationId: "att_...", risk: "high", matches: [...] }
```

`@openglass/core/testing` exports the conformance checks every integration should run
against its own event-extraction logic — see [`integrations/_template`](../integrations/_template).

## Develop

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm build
pnpm test
```
