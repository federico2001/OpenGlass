"""Realignment R7: live-stack integration coverage for the new lookup/attestation/guard
surface. Same skip-if-unreachable convention as test_integration.py."""

from __future__ import annotations

import time

import httpx
import pytest

from openglass import OpenGlassClient
from test_integration import BASE_URL, _claim_agent, _reachable

pytestmark = pytest.mark.skipif(not _reachable(), reason=f"OpenGlass stack not reachable at {BASE_URL}")


def test_lookup_reports_unregistered_then_registered() -> None:
    with OpenGlassClient(base_url=BASE_URL, http_client=httpx.Client(verify=False, timeout=30.0)) as client:
        miss = client.lookup(domain=f"sdk-py-test-nobody-{int(time.time() * 1000)}.example")
        assert miss["registered"] is False

        result = client.register_agent(name="sdk-py lookup test", description="Created by sdk-py's own test suite.")
        hit = client.lookup(agent_id=result["agent"]["id"])
        assert hit["registered"] is True
        assert hit["agentId"] == result["agent"]["id"]
        assert hit["claimed"] is False
        assert hit["flags"]["newAgent"] is True


def test_lookup_requires_exactly_one_query() -> None:
    with OpenGlassClient(base_url=BASE_URL, http_client=httpx.Client(verify=False, timeout=30.0)) as client:
        with pytest.raises(ValueError):
            client.lookup()
        with pytest.raises(ValueError):
            client.lookup(agent_id="agt_x", domain="example.com")


def test_attestation_round_trip() -> None:
    with OpenGlassClient(base_url=BASE_URL, http_client=httpx.Client(verify=False, timeout=30.0)) as client:
        result = client.register_agent(name="sdk-py attestation test", description="Created by sdk-py's own test suite.")
        _claim_agent(result["claim"]["url"])
        client.wait_until_claimed(timeout_s=15)

        # Explicit "shared" so the record's full bundle is available immediately — this
        # test exercises the attest -> event -> close -> bundle -> verify round trip, not
        # the separate private/sealed receipt-and-unseal ceremony (covered elsewhere).
        open_result = client.open_attestation(purpose="sdk-py attestation test.", visibility="shared")
        attestation = open_result["attestation"]
        assert attestation["status"] == "active"
        assert attestation["visibility"] == "shared"

        event_result = client.send_attestation_event(attestation["id"], {"text": "Did the thing."})
        assert event_result["head"]["seq"] == 1

        client.close_attestation(attestation["id"])
        record_id = client.wait_for_attestation_record(attestation["id"], timeout_s=20)
        assert record_id

        bundle = client.get_record_bundle(record_id)
        result_v = client.verify(bundle)
        assert result_v.errors == []
        assert result_v.valid is True


def test_guard_allows_low_risk_without_calling_openglass() -> None:
    client = OpenGlassClient(base_url="https://this-host-does-not-resolve.invalid", http_client=httpx.Client(verify=False, timeout=2.0))
    result = client.guard(risk="low", counterparty_agent_id="agt_whatever")
    assert result["action"] == "allow"
    assert "below the check threshold" in result["reason"]


def test_guard_fails_open_when_unreachable() -> None:
    client = OpenGlassClient(base_url="https://this-host-does-not-resolve.invalid", http_client=httpx.Client(verify=False, timeout=2.0))
    result = client.guard(risk="high", counterparty_agent_id="agt_whatever")
    assert result["action"] == "allow"
    assert "failing open" in result["reason"]


def test_guard_allows_brand_new_counterparty_with_no_domain_claim() -> None:
    with OpenGlassClient(base_url=BASE_URL, http_client=httpx.Client(verify=False, timeout=30.0)) as client:
        result = client.register_agent(name="sdk-py guard test counterparty", description="Created by sdk-py's own test suite.")
        guard_result = client.guard(risk="high", counterparty_agent_id=result["agent"]["id"])
        assert guard_result["action"] == "allow"
        assert "first time seeing this counterparty" in guard_result["reason"]


def test_guard_warns_on_unverified_domain() -> None:
    with OpenGlassClient(base_url=BASE_URL, http_client=httpx.Client(verify=False, timeout=30.0)) as client:
        result = client.register_agent(
            name="sdk-py guard test counterparty (unverified domain)",
            description="Created by sdk-py's own test suite.",
            meta={"homepage": f"https://sdk-py-guard-test-{int(time.time() * 1000)}.example"},
        )
        guard_result = client.guard(risk="high", counterparty_agent_id=result["agent"]["id"])
        assert guard_result["action"] == "warn"
        assert "domain is not verified" in guard_result["reason"]
