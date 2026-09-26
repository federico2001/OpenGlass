"""Proves openglass-langchain satisfies the shared conformance contract from
openglass-core — the same suite every OpenGlass integration must pass — using a real
LangChain tool invocation through the real callback handler pipeline.
"""

from __future__ import annotations

from typing import Any

import httpx
from fake_server import failing_client, make_handler
from langchain_core.tools import StructuredTool
from openglass import AgentIdentity, generate_ed25519_keypair
from openglass_core.attest import AttestOptions, AttestResult, evaluate_and_attest
from openglass_core.policy import load_policy
from openglass_core.testing import ConformanceFixtures, assert_attests_high_risk, assert_fails_open_on_api_error, assert_skips_low_risk
from openglass_langchain import OpenGlassCallbackHandler, extract_tool_event

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


def _tool_for(name: str) -> StructuredTool:
    return StructuredTool.from_function(func=lambda: "ok", name=name, description=f"Runs {name}.")


class Harness:
    """Runs a real LangChain tool call through the real callback handler (proving the
    handler wiring works), then re-derives the same verdict directly via
    `evaluate_and_attest` to report back — the handler itself is fire-and-forget per
    LangChain's callback contract, with no return channel to the caller."""

    def __init__(self, identity: AgentIdentity, attest_options: AttestOptions) -> None:
        self._identity = identity
        self._attest_options = attest_options
        self._handler = OpenGlassCallbackHandler(identity, POLICY, attest_options=attest_options)

    def process(self, native_event: Any) -> AttestResult:
        tool = _tool_for(native_event["tool"])
        tool.invoke({}, config={"callbacks": [self._handler]})
        return evaluate_and_attest(self._identity, POLICY, extract_tool_event(native_event["tool"], {}), self._attest_options)


def success_harness() -> Harness:
    handler, _ = make_handler()
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return Harness(make_identity(), {"http_client": client})


def failing_harness() -> Harness:
    return Harness(make_identity(), {"http_client": failing_client(), "retries": 1, "on_error": lambda e: None})


FIXTURES: ConformanceFixtures = {"high_risk": {"tool": "transfer_funds"}, "low_risk": {"tool": "list_calendar"}}


def test_attests_a_high_risk_event() -> None:
    assert_attests_high_risk(success_harness(), FIXTURES)


def test_skips_a_low_risk_event() -> None:
    assert_skips_low_risk(success_harness(), FIXTURES)


def test_fails_open_when_the_api_is_unreachable() -> None:
    assert_fails_open_on_api_error(failing_harness(), FIXTURES)
