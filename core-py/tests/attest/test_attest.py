from __future__ import annotations

import json
import re
from typing import Any, Callable
from unittest.mock import Mock

import httpx
from openglass import (
    AgentIdentity,
    VerifyingKey,
    canonicalize,
    generate_ed25519_keypair,
    sha256,
    verify_signature,
)
from openglass_core.attest import evaluate_and_attest, witness_if_risky
from openglass_core.policy import load_policy

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


def make_handler(identity: AgentIdentity) -> tuple[Callable[[httpx.Request], httpx.Response], list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body_str = request.content.decode("utf-8") if request.content else ""
        body = json.loads(body_str) if body_str else None
        calls.append({"method": request.method, "path": request.url.path, "body": body})

        headers = request.headers
        body_sha256 = sha256(body_str.encode("utf-8")).hex()
        digest = sha256(canonicalize({"method": request.method, "path": request.url.path, "timestamp": headers["og-timestamp"], "nonce": headers["og-nonce"], "bodySha256": body_sha256}).encode("utf-8"))
        valid = verify_signature(
            VerifyingKey(alg="Ed25519", kid=identity.kid, public_key=identity.public_key),
            "request",
            digest,
            {"alg": "Ed25519", "kid": headers["og-key"], "sig": headers["og-signature"]},
        )
        if not valid:
            return httpx.Response(401, json={"error": {"code": "invalid_request_signature"}})

        path = request.url.path
        if request.method == "POST" and path == "/v1/attestations":
            return httpx.Response(201, json={"attestation": {"id": body["open"]["attestationId"], "genesisHash": "a" * 64, "head": {"seq": 0, "hash": None}}})
        if request.method == "POST" and path.endswith("/events"):
            return httpx.Response(201, json={"head": {"seq": body["envelope"]["seq"], "hash": body["hash"]}})
        if request.method == "POST" and path.endswith("/close"):
            return httpx.Response(202, json={"attestation": {"status": "closing"}})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    return handler, calls


def fake_server(identity: AgentIdentity) -> tuple[httpx.Client, list[dict[str, Any]]]:
    handler, calls = make_handler(identity)
    return httpx.Client(transport=httpx.MockTransport(handler)), calls


def test_attests_a_high_risk_event_via_a_real_open_event_close_sequence() -> None:
    identity = make_identity()
    client, calls = fake_server(identity)
    result = evaluate_and_attest(identity, POLICY, {"attributes": {"gen_ai.tool.name": "transfer_funds"}}, {"http_client": client})

    assert result["attested"] is True
    assert re.match(r"^att_[0-9A-HJKMNP-TV-Z]{26}$", result["attestationId"])
    assert [m["id"] for m in result["matches"]] == ["risky-tool"]
    assert [c["path"] for c in calls] == [
        "/v1/attestations",
        f"/v1/attestations/{result['attestationId']}/events",
        f"/v1/attestations/{result['attestationId']}/close",
    ]


def test_does_not_attest_a_low_risk_event_and_never_calls_the_api() -> None:
    identity = make_identity()
    client, calls = fake_server(identity)
    result = evaluate_and_attest(identity, POLICY, {"attributes": {"gen_ai.tool.name": "list_calendar"}}, {"http_client": client})

    assert result == {"attested": False, "reason": "below_threshold", "risk": "low", "matches": []}
    assert calls == []


def test_respects_a_lower_min_risk_threshold() -> None:
    identity = make_identity()
    client, _ = fake_server(identity)
    medium_policy = load_policy(
        {
            "apiVersion": "openglass-policy/v1",
            "kind": "Policy",
            "metadata": {"name": "test"},
            "rules": [{"id": "medium-rule", "risk": "medium", "when": {"field": "field:a", "op": "exists"}}],
        }
    )
    result = evaluate_and_attest(identity, medium_policy, {"fields": {"a": 1}}, {"http_client": client, "min_risk": "medium"})
    assert result["attested"] is True


def test_fails_open_when_the_api_is_unreachable_after_retrying() -> None:
    identity = make_identity()
    attempts = 0

    def always_fails(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ConnectError("network down")

    client = httpx.Client(transport=httpx.MockTransport(always_fails))
    on_error = Mock()
    result = evaluate_and_attest(identity, POLICY, {"attributes": {"gen_ai.tool.name": "transfer_funds"}}, {"http_client": client, "retries": 3, "on_error": on_error})

    assert result["attested"] is False
    assert result["reason"] == "api_unreachable"
    assert result["risk"] == "high"
    assert attempts == 3
    on_error.assert_called_once()


def test_recovers_after_a_transient_failure_within_the_retry_budget() -> None:
    identity = make_identity()
    handler, _ = make_handler(identity)
    open_calls = 0

    def flaky(request: httpx.Request) -> httpx.Response:
        nonlocal open_calls
        if request.url.path == "/v1/attestations" and open_calls == 0:
            open_calls += 1
            raise httpx.ConnectError("transient")
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(flaky))
    result = evaluate_and_attest(identity, POLICY, {"attributes": {"gen_ai.tool.name": "transfer_funds"}}, {"http_client": client, "retries": 3})
    assert result["attested"] is True


def test_witness_if_risky_attests_first_then_always_runs_the_action() -> None:
    identity = make_identity()
    client, _ = fake_server(identity)
    action = Mock(return_value="action ran")
    result, attestation = witness_if_risky(identity, POLICY, {"attributes": {"gen_ai.tool.name": "transfer_funds"}}, action, {"http_client": client})
    assert result == "action ran"
    assert attestation["attested"] is True
    action.assert_called_once()


def test_witness_if_risky_still_runs_the_action_when_attestation_fails_open() -> None:
    identity = make_identity()

    def always_fails(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    client = httpx.Client(transport=httpx.MockTransport(always_fails))
    action = Mock(return_value="action ran anyway")
    result, attestation = witness_if_risky(
        identity, POLICY, {"attributes": {"gen_ai.tool.name": "transfer_funds"}}, action, {"http_client": client, "retries": 1, "on_error": lambda e: None}
    )
    assert result == "action ran anyway"
    assert attestation["attested"] is False
