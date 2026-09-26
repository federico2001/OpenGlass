"""Skeleton conformance test for a new integration (Python). Copy alongside your own
adapter.py, point `FIXTURES` at native events your own mapping actually classifies as
high/low risk under the policy you test with, and run these checks — the contract every
OpenGlass integration must satisfy. See ../../otel-py/tests/test_conformance.py for a
complete, real example.
"""

from __future__ import annotations

from typing import Any

import httpx
from adapter import NativeEvent, handle_native_event
from openglass import AgentIdentity, generate_ed25519_keypair
from openglass_core.policy import load_policy
from openglass_core.testing import ConformanceFixtures, assert_attests_high_risk, assert_fails_open_on_api_error, assert_skips_low_risk

POLICY = load_policy(
    {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "test"},
        # TODO: a minimal policy matching a real high-risk native event for your framework.
        "rules": [{"id": "risky", "risk": "high", "when": {"field": "attr:gen_ai.tool.name", "op": "equals", "value": "transfer_funds"}}],
    }
)


def make_identity() -> AgentIdentity:
    keypair = generate_ed25519_keypair()
    return AgentIdentity(agent_id="agt_test0000000000000000000000", kid="key_test0000000000000000000000", private_key=keypair.private_key, public_key=keypair.public_key)


class Harness:
    def __init__(self, client: httpx.Client) -> None:
        self._identity = make_identity()
        self._client = client

    def process(self, native_event: Any) -> Any:
        return handle_native_event(native_event, self._identity, POLICY, {"http_client": self._client})


# TODO: a MockTransport is enough for this — no real OpenGlass server needed. See
# otel-py's or openglass-core's own tests for the full open/event/close fake-server shape.
def _fake_client() -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/attestations":
            return httpx.Response(201, json={"attestation": {"id": "att_x", "genesisHash": "a" * 64, "head": {"seq": 0, "hash": None}}})
        if path.endswith("/events"):
            return httpx.Response(201, json={"head": {"seq": 1, "hash": "b" * 64}})
        return httpx.Response(202, json={})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _failing_client() -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated network failure")

    return httpx.Client(transport=httpx.MockTransport(handler))


FIXTURES: ConformanceFixtures = {
    "high_risk": NativeEvent(tool_name="transfer_funds"),
    "low_risk": NativeEvent(tool_name="list_calendar"),
}


def test_attests_a_high_risk_event() -> None:
    assert_attests_high_risk(Harness(_fake_client()), FIXTURES)


def test_skips_a_low_risk_event() -> None:
    assert_skips_low_risk(Harness(_fake_client()), FIXTURES)


def test_fails_open_when_the_api_is_unreachable() -> None:
    assert_fails_open_on_api_error(Harness(_failing_client()), FIXTURES)
