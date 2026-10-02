"""register_counterparty (docs/SPEC.md §16), against a scripted HTTP transport."""

from __future__ import annotations

import json

import httpx
import pytest

from openglass import OpenGlassClient
from openglass.http import OpenGlassApiError


def _client(handler) -> OpenGlassClient:
    identity = OpenGlassClient.generate_identity()
    identity.agent_id = "agt_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
    identity.kid = "key_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return OpenGlassClient(base_url="https://og.test", identity=identity, http_client=http)


def test_posts_the_agent_card_signed_and_returns_the_profile():
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(201, json={"profile": {"domain": "acme.example", "claimed": False}})

    card = {"name": "Acme", "url": "https://acme.example/a2a"}
    profile = _client(handler).register_counterparty(agent_card=card)
    assert profile == {"domain": "acme.example", "claimed": False}
    assert len(seen) == 1
    assert seen[0].method == "POST" and seen[0].url.path == "/v1/profiles/unclaimed"
    assert json.loads(seen[0].content) == {"agentCard": card}
    assert seen[0].headers["og-agent"] == "agt_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
    assert seen[0].headers["og-signature"]


def test_requires_exactly_one_way_to_name_the_counterparty():
    client = _client(lambda req: httpx.Response(500))
    with pytest.raises(ValueError):
        client.register_counterparty()
    with pytest.raises(ValueError):
        client.register_counterparty(domain="acme.example", agent_card_url="https://acme.example/card.json")


def test_raises_already_registered():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"error": {"code": "already_registered", "message": "taken", "details": {"agentId": "agt_X"}}})

    with pytest.raises(OpenGlassApiError) as exc:
        _client(handler).register_counterparty(agent_card_url="https://acme.example/.well-known/agent-card.json")
    assert exc.value.status == 409
