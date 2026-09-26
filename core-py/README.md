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

## Develop

```sh
pip install -e ".[dev]"
mypy src
pytest -v
```
