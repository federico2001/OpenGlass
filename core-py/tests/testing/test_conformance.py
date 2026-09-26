from __future__ import annotations

from typing import Any

import httpx
import pytest
from openglass import AgentIdentity, generate_ed25519_keypair
from openglass_core.attest import AttestResult, evaluate_and_attest
from openglass_core.policy import load_policy
from openglass_core.testing import (
    ConformanceFixtures,
    ConformanceHarness,
    assert_attests_high_risk,
    assert_fails_open_on_api_error,
    assert_skips_low_risk,
    run_all_conformance_checks,
)

POLICY = load_policy(
    {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "test"},
        "rules": [{"id": "risky", "risk": "high", "when": {"field": "field:tool", "op": "equals", "value": "transfer_funds"}}],
    }
)


def make_identity() -> AgentIdentity:
    keypair = generate_ed25519_keypair()
    return AgentIdentity(agent_id="agt_test0000000000000000000000", kid="key_test0000000000000000000000", private_key=keypair.private_key, public_key=keypair.public_key)


class Harness:
    def __init__(self, client: httpx.Client, **opts: Any) -> None:
        self._client = client
        self._identity = make_identity()
        self._opts = opts

    def process(self, native_event: Any) -> AttestResult:
        return evaluate_and_attest(self._identity, POLICY, native_event, {"http_client": self._client, **self._opts})


def success_harness() -> ConformanceHarness:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/attestations":
            return httpx.Response(201, json={"attestation": {"id": "att_x", "genesisHash": "a" * 64, "head": {"seq": 0, "hash": None}}})
        if path.endswith("/events"):
            return httpx.Response(201, json={"head": {"seq": 1, "hash": "b" * 64}})
        return httpx.Response(202, json={})

    return Harness(httpx.Client(transport=httpx.MockTransport(handler)))


def failing_harness() -> ConformanceHarness:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated network failure")

    return Harness(httpx.Client(transport=httpx.MockTransport(handler)), retries=1, on_error=lambda e: None)


FIXTURES: ConformanceFixtures = {"high_risk": {"fields": {"tool": "transfer_funds"}}, "low_risk": {"fields": {"tool": "list_calendar"}}}


def test_assert_attests_high_risk_passes_against_a_working_harness() -> None:
    assert_attests_high_risk(success_harness(), FIXTURES)


def test_assert_skips_low_risk_passes_against_a_working_harness() -> None:
    assert_skips_low_risk(success_harness(), FIXTURES)


def test_run_all_conformance_checks_passes_against_a_working_harness() -> None:
    run_all_conformance_checks(success_harness(), FIXTURES)


def test_assert_fails_open_on_api_error_passes_against_a_failing_harness() -> None:
    assert_fails_open_on_api_error(failing_harness(), FIXTURES)


def test_assert_attests_high_risk_fails_loudly_against_a_harness_that_never_attests() -> None:
    class BrokenHarness:
        def process(self, native_event: Any) -> AttestResult:
            return {"attested": False, "reason": "below_threshold", "risk": "low", "matches": []}

    with pytest.raises(AssertionError, match="expected an attestation"):
        assert_attests_high_risk(BrokenHarness(), FIXTURES)


def test_assert_skips_low_risk_fails_loudly_against_a_harness_that_over_attests() -> None:
    class OverAttests:
        def process(self, native_event: Any) -> AttestResult:
            return {"attested": True, "attestationId": "att_x", "risk": "high", "matches": []}

    with pytest.raises(AssertionError, match="expected no attestation"):
        assert_skips_low_risk(OverAttests(), FIXTURES)
