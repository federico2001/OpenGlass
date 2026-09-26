from __future__ import annotations

from typing import Any, Callable

import httpx


def make_handler() -> tuple[Callable[[httpx.Request], httpx.Response], list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append({"method": request.method, "path": request.url.path})
        path = request.url.path
        if request.method == "POST" and path == "/v1/attestations":
            return httpx.Response(201, json={"attestation": {"id": "att_x", "genesisHash": "a" * 64, "head": {"seq": 0, "hash": None}}})
        if request.method == "POST" and path.endswith("/events"):
            return httpx.Response(201, json={"head": {"seq": 1, "hash": "b" * 64}})
        if request.method == "POST" and path.endswith("/close"):
            return httpx.Response(202, json={"attestation": {"status": "closing"}})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    return handler, calls


def fake_client() -> tuple[httpx.Client, list[dict[str, Any]]]:
    handler, calls = make_handler()
    return httpx.Client(transport=httpx.MockTransport(handler)), calls


def failing_client() -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("simulated network failure")

    return httpx.Client(transport=httpx.MockTransport(handler))
