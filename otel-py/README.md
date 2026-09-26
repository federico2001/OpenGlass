# openglass-otel

An OpenTelemetry `SpanProcessor` that reads [GenAI semantic-convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
spans, classifies each against an [`openglass-policy`](../spec/openglass-policy), and
opens an [OpenGlass attestation](../docs/SPEC.md#12-attestations) for the risky ones —
zero code changes to an already-OTel-instrumented agent, beyond registering the
processor.

Built on [`openglass-core`](../core-py): the policy evaluation, retry, and fail-open
behavior are `openglass_core.attest`'s; this package is just the OTel-specific
span-to-event mapping and batching on top.

## Quickstart

```python
from opentelemetry.sdk.trace import TracerProvider
from openglass_otel import OpenGlassSpanProcessor
from openglass_core.attest import load_or_create_identity
from openglass_core.policy import load_policy
from pathlib import Path

identity = load_or_create_identity("openglass-identity.json")
policy = load_policy(Path("default.yaml").read_text())

provider = TracerProvider()
provider.add_span_processor(OpenGlassSpanProcessor(identity=identity, policy=policy))
```

Any span your instrumentation already emits with `gen_ai.*` attributes (tool name,
operation name, etc.) is picked up automatically. A span that ends in error and wasn't
tagged with `error.type` directly gets one synthesized from the span's own status, so the
default policy's error-adjacent rules still fire.

## Batching

`on_end` only enqueues a span (`SpanProcessor.on_end` runs on the application thread, so
it stays cheap); actual policy evaluation and attestation calls happen on
`scheduled_delay_millis` (default 5000) or immediately via `processor.force_flush()` —
so a slow OpenGlass API never blocks span processing, on top of `evaluate_and_attest`'s
own per-call fail-open behavior.

## Mapping your own fields in

Pass `extract_event` to add fields beyond the OTel GenAI attributes:

```python
OpenGlassSpanProcessor(
    identity=identity,
    policy=policy,
    extract_event=lambda span: {"attributes": dict(span.attributes or {}), "fields": {"amountUsd": span.attributes.get("myapp.amount_usd")}},
)
```

## Conformance

This package's own test suite (`tests/test_conformance.py`) runs the shared
`openglass_core.testing` conformance checks against its real span-processing pipeline —
the same checks any other integration (see [`integrations/_template`](../integrations/_template))
should run against its own event mapping.

## Develop

```sh
pip install -e ".[dev]"
mypy src
pytest -v
```
