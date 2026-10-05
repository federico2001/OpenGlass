"""attested_fetch (docs/SPEC.md §12.7), against a scripted HTTP transport — same
httpx.MockTransport pattern as test_register_counterparty.py, so every branch runs through
the real witness_fetch()/signed_request() path, not a mocked method. Mirrors sdk-js's own
test/attestedFetch.test.ts (mode "off"/"primary"/"shadow", the target-vs-platform-
unreachable distinction, and that a fallback or failed witness is never silently presented
as witnessed).
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from openglass import OpenGlassClient


def _client(handler: Any) -> OpenGlassClient:
    identity = OpenGlassClient.generate_identity()
    identity.agent_id = "agt_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
    identity.kid = "key_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return OpenGlassClient(base_url="https://og.test", identity=identity, http_client=http)


def _unreachable_handler(req: httpx.Request) -> httpx.Response:
    pytest.fail("OpenGlass should not have been called")


def _witness_response(**overrides: Any) -> dict[str, Any]:
    response = {"status": 200, "headers": {}, "contentType": "application/json", "bodySha256": "b" * 64, "bodyBytes": 5, "bodyTruncated": False, "bodyText": "hello"}
    response.update(overrides)
    return {
        "id": "wfx_test",
        "attestationId": "att_1",
        "requestedBy": "agt_1",
        "seq": 1,
        "prevHash": "a" * 64,
        "url": "https://target.example/",
        "method": "GET",
        "request": None,
        "requestedAt": "2026-10-05T00:00:00.000Z",
        "fetchedAt": "2026-10-05T00:00:00.100Z",
        "response": response,
        "hash": "c" * 64,
        "platformSignature": {"alg": "ECDSA_P256_SHA256", "kid": "plat-1", "sig": "sig"},
    }


def test_mode_off_runs_direct_fetch_only_and_never_calls_openglass() -> None:
    client = _client(_unreachable_handler)
    calls: list[tuple[str, str, Any]] = []

    def direct_fetch(url: str, method: str, body: Any) -> dict[str, Any]:
        calls.append((url, method, body))
        return {"status": 200, "headers": {}, "body": b"direct"}

    result = client.attested_fetch("att_1", "https://target.example", mode="off", direct_fetch=direct_fetch)

    assert result == {"witnessed": False, "reason": "off", "witness": None, "direct": {"status": 200, "headers": {}, "body": b"direct"}}
    assert calls == [("https://target.example", "GET", None)]


def test_mode_primary_default_uses_openglasss_own_fetch_as_the_only_request() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"witness": _witness_response()})

    client = _client(handler)
    result = client.attested_fetch("att_1", "https://target.example", direct_fetch=_fail_if_called)

    assert result["witnessed"] is True
    assert result["reason"] == "primary"
    assert result["witness"]["id"] == "wfx_test"
    assert result["direct"] is None


def test_mode_primary_falls_back_to_direct_only_when_openglass_itself_is_unreachable() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": {"code": "unavailable"}})

    client = _client(handler)
    calls: list[str] = []

    def direct_fetch(url: str, method: str, body: Any) -> dict[str, Any]:
        calls.append(url)
        return {"status": 200, "headers": {}, "body": b"direct"}

    result = client.attested_fetch("att_1", "https://target.example", direct_fetch=direct_fetch)

    assert result["witnessed"] is False
    assert result["reason"].startswith("openglass_unreachable_fallback:")
    assert result["direct"] == {"status": 200, "headers": {}, "body": b"direct"}
    assert calls == ["https://target.example"]


def test_mode_primary_never_duplicates_when_openglass_witnessed_the_target_itself_failing() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"error": {"code": "url_unreachable", "message": "blocked"}})

    client = _client(handler)
    result = client.attested_fetch("att_1", "https://target.example", direct_fetch=_fail_if_called)

    assert result["witnessed"] is False
    assert result["reason"].startswith("target_unreachable:")
    assert result["direct"] is None
    assert result["witness"] is None


def test_mode_shadow_scores_off_direct_and_witnesses_the_same_request_afterward() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"witness": _witness_response()})

    client = _client(handler)
    direct_calls: list[str] = []

    def direct_fetch(url: str, method: str, body: Any) -> dict[str, Any]:
        direct_calls.append(url)
        return {"status": 200, "headers": {}, "body": b"direct"}

    result = client.attested_fetch("att_1", "https://target.example", mode="shadow", direct_fetch=direct_fetch)

    assert result["witnessed"] is True
    assert result["reason"] == "shadow"
    assert result["witness"]["id"] == "wfx_test"
    assert result["direct"] == {"status": 200, "headers": {}, "body": b"direct"}
    assert direct_calls == ["https://target.example"]


def test_mode_shadow_still_returns_the_real_direct_result_when_the_witness_attempt_fails() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"code": "internal"}})

    client = _client(handler)
    direct = {"status": 200, "headers": {}, "body": b"direct"}
    result = client.attested_fetch("att_1", "https://target.example", mode="shadow", direct_fetch=lambda *a: direct)

    assert result["witnessed"] is False
    assert result["reason"].startswith("shadow_witness_failed:")
    assert result["direct"] == direct


def test_attestation_id_none_forces_off_regardless_of_mode_and_still_runs_direct_fetch() -> None:
    client = _client(_unreachable_handler)
    direct = {"status": 200, "headers": {}, "body": b"direct"}
    result = client.attested_fetch(None, "https://target.example", mode="primary", direct_fetch=lambda *a: direct)

    assert result == {"witnessed": False, "reason": "no_attestation", "witness": None, "direct": direct}


def test_method_and_body_pass_through_to_witness_fetch_untouched() -> None:
    seen: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        import json

        seen.append(json.loads(req.content))
        return httpx.Response(201, json={"witness": _witness_response()})

    client = _client(handler)
    client.attested_fetch("att_1", "https://target.example", method="POST", body={"hello": 1})

    assert seen == [{"url": "https://target.example", "method": "POST", "body": {"hello": 1}}]


def _fail_if_called(url: str, method: str, body: Any) -> dict[str, Any]:
    pytest.fail("direct_fetch should not have been called")
