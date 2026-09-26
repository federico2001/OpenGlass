# OpenGlass Policy

A small, versioned, vendor-neutral YAML format for classifying an agent's action as
`low`, `medium`, or `high` risk — the judgment call that decides whether an action
deserves a witnessed record, a pause for human review, or nothing at all. The format
itself has no opinion on what happens after classification: what a `high` verdict
triggers (open an [OpenGlass attestation](SPEC.md#12-attestations), block the call, page
someone, just log it) is entirely up to the caller. The spec, JSON Schema, and default
policy live at [`/spec/openglass-policy`](https://github.com/federico2001/OpenGlass/tree/main/spec/openglass-policy)
in the repo; `@openglass/core` (TypeScript) and `openglass-core` (Python) are reference
evaluators for it, kept in sync by a shared set of test vectors.

## Why a spec instead of just a TypeScript type

Events come from everywhere: OpenTelemetry-instrumented frameworks, custom logging,
other languages entirely. A JSON Schema plus a plain YAML document can be validated,
generated, and consumed by tooling that has never heard of OpenGlass or Node.js — the
same reasoning that put [`openapi.yaml`](openapi.yaml), not a TypeScript interface, at
the center of the HTTP API.

## Format

```yaml
apiVersion: openglass-policy/v1
kind: Policy
metadata:
  name: default
  description: "..."
defaultRisk: low # applied when no rule matches; defaults to "low" if omitted
rules:
  - id: financial-transaction # unique, kebab-case, stable across edits
    risk: high # low | medium | high
    description: "..."
    when: <condition>
    reasons: ["Tool name suggests a funds transfer"] # surfaced in the result when matched
```

A `condition` is either a leaf match or a boolean combination of sub-conditions:

```yaml
# leaf: { field, op, value? }
field: attr:gen_ai.tool.name
op: matches
value: "(?i)(transfer|withdraw)"

# combinators nest arbitrarily
any:
  - all:
      - field: attr:gen_ai.operation.name
        op: equals
        value: execute_tool
      - field: field:amountUsd
        op: gte
        value: 1000
  - field: field:destructive
    op: equals
    value: true
```

**Field addressing** has two forms, matching the two places a value can come from:

- `attr:<key>` — an exact-key lookup into the event's [OpenTelemetry GenAI semantic
  convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/) attributes (e.g.
  `attr:gen_ai.tool.name`, `attr:gen_ai.operation.name`, `attr:error.type`). OTel span
  attribute keys are flat strings that already contain dots, so this form never
  traverses — the text after `attr:` is the literal key.
- `field:<path>` — a dotted-path lookup into whatever plain fields the caller passes
  alongside (or instead of) OTel attributes — e.g. `field:amountUsd`,
  `field:payload.recipient.country`. This is the escape hatch for frameworks that don't
  emit OTel GenAI spans at all, or for fields OTel has no semantic convention for.

**Operators**: `equals`, `not_equals`, `in`, `not_in`, `matches` (regex, `(?i)` for
case-insensitive), `contains` (substring or array membership), `gt`/`gte`/`lt`/`lte`
(numeric), `exists`/`not_exists`.

## Evaluation

Every rule is checked against the event; a rule "matches" if its `when` condition is
true. The result is the **highest risk level among matched rules** (`high` > `medium` >
`low`), together with the ids/descriptions/reasons of every rule that matched — not just
the winning one. An event matching no rule gets `defaultRisk`.

```ts
import { loadPolicy, evaluate } from "@openglass/core/policy";

const policy = loadPolicy(yamlString);
const result = evaluate(policy, {
  attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "transfer_funds" },
  fields: { amountUsd: 500 },
});
// { risk: "high", matches: [{ id: "financial-transaction", risk: "high", reasons: [...] }], defaultApplied: false }
```

```python
from openglass_core.policy import load_policy, evaluate

policy = load_policy(yaml_string)
result = evaluate(policy, {
    "attributes": {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "transfer_funds"},
    "fields": {"amountUsd": 500},
})
```

## The default policy

`v1/default.yaml` is a general-purpose starting point covering the action categories
most agent frameworks and incident writeups agree are worth a human-verifiable trail:
money movement, destructive operations, credential/access changes, arbitrary code
execution, external communication sent as the user, and legal/contractual commitments.
The specific tool names and thresholds are illustrative defaults, meant to be forked and
tightened per deployment, not the only correct values.

## Versioning

`apiVersion` is part of the document (`openglass-policy/v1`) and the JSON Schema lives
under a matching `v1/` directory. A breaking change to the format ships as `v2/`
alongside `v1/`, never by mutating `v1/schema.json` in place — existing policies keep
validating against the version they declared.

## Writing your own policy

Fork `v1/default.yaml`, keep `apiVersion`/`kind` as they are, pick your own
`metadata.name`, and add/remove/edit rules. Validate it against `v1/schema.json` with any
JSON Schema (2020-12) validator, or just run it through `loadPolicy()`/`load_policy()`,
which validates as part of loading.
