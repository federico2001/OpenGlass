"""send_message chain handling (docs/SPEC.md §5.3, D8), against a scripted HTTP transport.

Two agents talking means the head moves under you: the other side's messages advance it
between your sends. send_message must (1) read the head from the session when it doesn't
know it, and (2) re-chain onto the real head and retry when the server answers
409 chain_conflict — otherwise a normal back-and-forth fails on its second turn.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from openglass import OpenGlassClient
from openglass.crypto import canonicalize, sha256, to_hex
from openglass.http import OpenGlassApiError

SESSION = "ses_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
GENESIS = "a" * 64
H2 = "b" * 64


def _client(handler) -> OpenGlassClient:
    identity = OpenGlassClient.generate_identity()
    identity.agent_id = "agt_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
    identity.kid = "key_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return OpenGlassClient(base_url="https://og.test", identity=identity, http_client=http)


def _expected_hash(envelope: dict[str, Any]) -> str:
    return to_hex(sha256(bytes.fromhex(envelope["prevHash"]) + canonicalize(envelope).encode("utf-8")))


def _accept(body: dict[str, Any]) -> httpx.Response:
    env = body["envelope"]
    assert body["hash"] == _expected_hash(env), "client must sign the hash of the envelope it actually sent"
    return httpx.Response(201, json={"message": {"seq": env["seq"]}, "head": {"seq": env["seq"], "hash": body["hash"]}})


def test_reads_the_head_from_the_session_when_it_has_none():
    posts: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET" and req.url.path == f"/v1/sessions/{SESSION}":
            return httpx.Response(200, json={"session": {"status": "active", "genesisHash": GENESIS, "head": {"seq": 0, "hash": None}}})
        body = json.loads(req.content)
        posts.append(body)
        return _accept(body)

    client = _client(handler)
    client.send_message(SESSION, {"offer": 1})
    assert [(p["envelope"]["seq"], p["envelope"]["prevHash"]) for p in posts] == [(1, GENESIS)]


def test_rechains_onto_the_servers_head_after_a_chain_conflict():
    posts: list[dict[str, Any]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json={"session": {"status": "active", "genesisHash": GENESIS, "head": {"seq": 0, "hash": None}}})
        body = json.loads(req.content)
        posts.append(body)
        if len(posts) == 1:
            # The other agent already sent seq 1 and 2; our stale seq-1 send is rejected.
            return httpx.Response(409, json={"error": {"code": "chain_conflict", "message": "Head has moved", "details": {"head": {"seq": 2, "hash": H2}}}})
        return _accept(body)

    client = _client(handler)
    result = client.send_message(SESSION, {"accept": True})
    assert [(p["envelope"]["seq"], p["envelope"]["prevHash"]) for p in posts] == [(1, GENESIS), (3, H2)]
    assert result["head"]["seq"] == 3
    assert posts[0]["payload"] == posts[1]["payload"]


def test_gives_up_after_retry_on_conflict_attempts():
    calls = {"post": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json={"session": {"status": "active", "genesisHash": GENESIS, "head": {"seq": 0, "hash": None}}})
        calls["post"] += 1
        return httpx.Response(409, json={"error": {"code": "chain_conflict", "message": "Head has moved", "details": {"head": {"seq": calls["post"], "hash": H2}}}})

    client = _client(handler)
    with pytest.raises(OpenGlassApiError):
        client.send_message(SESSION, {"x": 1}, retry_on_conflict=2)
    assert calls["post"] == 3


def test_explicit_seq_and_prev_hash_are_never_retried():
    calls = {"post": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["post"] += 1
        return httpx.Response(409, json={"error": {"code": "chain_conflict", "message": "Head has moved", "details": {"head": {"seq": 5, "hash": H2}}}})

    client = _client(handler)
    with pytest.raises(OpenGlassApiError):
        client.send_message(SESSION, {"x": 1}, seq=1, prev_hash=GENESIS)
    assert calls["post"] == 1


def test_other_errors_are_not_retried():
    calls = {"post": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json={"session": {"status": "active", "genesisHash": GENESIS, "head": {"seq": 0, "hash": None}}})
        calls["post"] += 1
        return httpx.Response(409, json={"error": {"code": "session_not_active", "message": "closed"}})

    client = _client(handler)
    with pytest.raises(OpenGlassApiError):
        client.send_message(SESSION, {"x": 1})
    assert calls["post"] == 1


def test_a_pending_session_explains_what_to_wait_for():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"session": {"status": "pending", "genesisHash": None, "head": {"seq": 0, "hash": None}}})

    client = _client(handler)
    with pytest.raises(RuntimeError, match="wait_for_active"):
        client.send_message(SESSION, {"x": 1})
