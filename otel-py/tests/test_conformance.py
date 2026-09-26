"""Proves openglass-otel's real pipeline (a genuine OTel span -> extract_gen_ai_event ->
evaluate_and_attest) satisfies the shared conformance contract from openglass-core — the
same suite every OpenGlass integration must pass. This exercises exactly the mapping and
attestation logic OpenGlassSpanProcessor uses internally; its own queueing/batching
behavior is covered separately in test_span_processor.py.
"""

from __future__ import annotations

from typing import Any

import httpx
from fake_server import failing_client, make_handler
from openglass import AgentIdentity, generate_ed25519_keypair
from openglass_core.attest import evaluate_and_attest
from openglass_core.policy import load_policy
from openglass_core.testing import ConformanceFixtures, assert_attests_high_risk, assert_fails_open_on_api_error, assert_skips_low_risk
from openglass_otel import extract_gen_ai_event
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

POLICY = load_policy(
    {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "test"},
        "rules": [{"id": "risky", "risk": "high", "when": {"field": "attr:gen_ai.tool.name", "op": "equals", "value": "transfer_funds"}}],
    }
)


def make_identity() -> AgentIdentity:
    keypair = generate_ed25519_keypair()
    return AgentIdentity(agent_id="agt_test0000000000000000000000", kid="key_test0000000000000000000000", private_key=keypair.private_key, public_key=keypair.public_key)


class Harness:
    def __init__(self, http_client: httpx.Client) -> None:
        self._identity = make_identity()
        self._http_client = http_client
        self._exporter = InMemorySpanExporter()
        self._provider = TracerProvider()
        self._provider.add_span_processor(SimpleSpanProcessor(self._exporter))
        self._tracer = self._provider.get_tracer("conformance")

    def process(self, native_event: Any) -> Any:
        self._exporter.clear()
        with self._tracer.start_as_current_span("execute_tool") as span:
            span.set_attribute("gen_ai.tool.name", native_event["tool"])
        (readable_span,) = self._exporter.get_finished_spans()
        return evaluate_and_attest(self._identity, POLICY, extract_gen_ai_event(readable_span), {"http_client": self._http_client})


FIXTURES: ConformanceFixtures = {"high_risk": {"tool": "transfer_funds"}, "low_risk": {"tool": "list_calendar"}}


def test_attests_a_high_risk_event() -> None:
    client, _ = _fake_client()
    assert_attests_high_risk(Harness(client), FIXTURES)


def test_skips_a_low_risk_event() -> None:
    client, _ = _fake_client()
    assert_skips_low_risk(Harness(client), FIXTURES)


def test_fails_open_when_the_api_is_unreachable() -> None:
    assert_fails_open_on_api_error(Harness(failing_client()), FIXTURES)


def _fake_client() -> tuple[httpx.Client, list[dict[str, Any]]]:
    handler, calls = make_handler()
    return httpx.Client(transport=httpx.MockTransport(handler)), calls
