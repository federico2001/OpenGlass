# openglass-core

The reference Python evaluator for [`openglass-policy`](../spec/openglass-policy) — a
small, versioned, vendor-neutral format for classifying an agent's action as `low`,
`medium`, or `high` risk. Standalone package (like [`sdk-py`](../sdk-py)/[`sdk-js`](../sdk-js)),
on its own release cadence.

This is the policy piece of what will grow into OpenGlass's integration kit — the
runtime an OpenTelemetry-instrumented app pulls in to decide, per tool call, whether an
action is worth a witnessed record.

## Quickstart

```python
from pathlib import Path
from openglass_core.policy import load_policy, evaluate

policy = load_policy(Path("default.yaml").read_text())

result = evaluate(policy, {
    "attributes": {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "transfer_funds"},
    "fields": {"amountUsd": 500},
})
# {"risk": "high", "matches": [{"id": "financial-transaction", "risk": "high", "reasons": [...]}], "defaultApplied": False}
```

See [`spec/openglass-policy/README.md`](../spec/openglass-policy/README.md) for the full
format guide (field addressing, operators, versioning) and
[`spec/openglass-policy/v1/default.yaml`](../spec/openglass-policy/v1/default.yaml) for a
ready-to-fork starting policy.

## Attesting a risky event

`openglass_core.attest` is the primitive every integration (like
[`openglass-otel`](../otel-py)) calls once policy evaluation says an event is risky —
open a one-party [attestation](../docs/SPEC.md#12-attestations), append one event
recording the classified action and its verdict, close it. Fails open by design: an
unreachable API is retried, then reported via `on_error`, never raised — it doesn't
block whatever real action the event describes.

```python
from pathlib import Path
from openglass_core.attest import load_or_create_identity, evaluate_and_attest
from openglass_core.policy import load_policy

identity = load_or_create_identity("openglass-identity.json")  # generated + persisted on first use
policy = load_policy(Path("default.yaml").read_text())

result = evaluate_and_attest(identity, policy, {
    "attributes": {"gen_ai.tool.name": "transfer_funds"},
    "fields": {"amountUsd": 500},
})
# {"attested": True, "attestationId": "att_...", "risk": "high", "matches": [...]}
```

`openglass_core.testing` exports the conformance checks every integration should run
against its own event-extraction logic — see [`integrations/_template`](../integrations/_template).

## Develop

```sh
pip install -e ".[dev]"
mypy src
pytest -v
```
