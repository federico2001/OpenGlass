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

## Develop

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm build
pnpm test
```
