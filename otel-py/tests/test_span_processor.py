from __future__ import annotations

import time

from fake_server import fake_client, failing_client
from openglass import AgentIdentity, generate_ed25519_keypair
from openglass_core.policy import load_policy
from openglass_otel import OpenGlassSpanProcessor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.trace import Status, StatusCode

POLICY = load_policy(
    {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "test"},
        "rules": [{"id": "risky-tool", "risk": "high", "when": {"field": "attr:gen_ai.tool.name", "op": "equals", "value": "transfer_funds"}}],
    }
)


def make_identity() -> AgentIdentity:
    keypair = generate_ed25519_keypair()
    return AgentIdentity(agent_id="agt_test0000000000000000000000", kid="key_test0000000000000000000000", private_key=keypair.private_key, public_key=keypair.public_key)


def test_attests_a_high_risk_gen_ai_span_once_flushed() -> None:
    client, calls = fake_client()
    processor = OpenGlassSpanProcessor(identity=make_identity(), policy=POLICY, attest_options={"http_client": client})
    provider = TracerProvider()
    provider.add_span_processor(processor)
    tracer = provider.get_tracer("test")

    with tracer.start_as_current_span("execute_tool") as span:
        span.set_attribute("gen_ai.operation.name", "execute_tool")
        span.set_attribute("gen_ai.tool.name", "transfer_funds")

    processor.force_flush()
    paths = [c["path"] for c in calls]
    assert paths[0] == "/v1/attestations"
    assert paths[1].startswith("/v1/attestations/att_") and paths[1].endswith("/events")
    assert paths[2].startswith("/v1/attestations/att_") and paths[2].endswith("/close")
    provider.shutdown()


def test_does_not_attest_a_benign_gen_ai_span() -> None:
    client, calls = fake_client()
    processor = OpenGlassSpanProcessor(identity=make_identity(), policy=POLICY, attest_options={"http_client": client})
    provider = TracerProvider()
    provider.add_span_processor(processor)
    tracer = provider.get_tracer("test")

    with tracer.start_as_current_span("execute_tool") as span:
        span.set_attribute("gen_ai.tool.name", "list_calendar")

    processor.force_flush()
    assert calls == []
    provider.shutdown()


def test_synthesizes_error_type_from_span_status_when_not_set() -> None:
    client, calls = fake_client()
    error_policy = load_policy(
        {
            "apiVersion": "openglass-policy/v1",
            "kind": "Policy",
            "metadata": {"name": "test"},
            "rules": [{"id": "errored", "risk": "high", "when": {"field": "attr:error.type", "op": "exists"}}],
        }
    )
    processor = OpenGlassSpanProcessor(identity=make_identity(), policy=error_policy, attest_options={"http_client": client})
    provider = TracerProvider()
    provider.add_span_processor(processor)
    tracer = provider.get_tracer("test")

    with tracer.start_as_current_span("execute_tool") as span:
        span.set_status(Status(StatusCode.ERROR, "boom"))

    processor.force_flush()
    assert any(c["path"] == "/v1/attestations" for c in calls)
    provider.shutdown()


def test_batches_multiple_ended_spans_into_one_flush() -> None:
    client, calls = fake_client()
    processor = OpenGlassSpanProcessor(identity=make_identity(), policy=POLICY, attest_options={"http_client": client})
    provider = TracerProvider()
    provider.add_span_processor(processor)
    tracer = provider.get_tracer("test")

    for i in range(3):
        with tracer.start_as_current_span(f"tool-{i}") as span:
            span.set_attribute("gen_ai.tool.name", "transfer_funds")

    processor.force_flush()
    opens = [c for c in calls if c["path"] == "/v1/attestations"]
    assert len(opens) == 3
    provider.shutdown()


def test_flushes_automatically_on_its_scheduled_interval() -> None:
    client, calls = fake_client()
    processor = OpenGlassSpanProcessor(identity=make_identity(), policy=POLICY, scheduled_delay_millis=100, attest_options={"http_client": client})
    provider = TracerProvider()
    provider.add_span_processor(processor)
    tracer = provider.get_tracer("test")

    with tracer.start_as_current_span("execute_tool") as span:
        span.set_attribute("gen_ai.tool.name", "transfer_funds")

    assert calls == []
    time.sleep(0.3)
    assert any(c["path"] == "/v1/attestations" for c in calls)
    provider.shutdown()


def test_fails_open_when_the_api_is_unreachable() -> None:
    processor = OpenGlassSpanProcessor(identity=make_identity(), policy=POLICY, attest_options={"http_client": failing_client(), "retries": 1, "on_error": lambda e: None})
    provider = TracerProvider()
    provider.add_span_processor(processor)
    tracer = provider.get_tracer("test")

    with tracer.start_as_current_span("execute_tool") as span:
        span.set_attribute("gen_ai.tool.name", "transfer_funds")

    processor.force_flush()  # must not raise
    provider.shutdown()
