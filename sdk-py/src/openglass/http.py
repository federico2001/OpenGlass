"""SPEC §4.1 signed-request helper, ported from skill.md's own reference implementation
(tested end to end against a live server) plus a plain client for OpenGlass's public,
unauthenticated endpoints."""

from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timezone
from typing import Any

import httpx

from .crypto import base64url_encode, canonicalize, sha256, sign_ed25519, sig_input, to_hex
from .types import AgentIdentity

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32, no I/L/O/U


class OpenGlassApiError(Exception):
    def __init__(self, method: str, path: str, status: int, body: Any) -> None:
        super().__init__(f"{method} {path} -> {status}: {json.dumps(body)}")
        self.method = method
        self.path = path
        self.status = status
        self.body = body


def _now_iso() -> str:
    """RFC 3339 UTC with milliseconds, e.g. ``2026-09-23T15:16:29.227Z`` — the exact
    format SPEC's signed timestamps require."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def signed_request(client: httpx.Client, base_url: str, method: str, path: str, body: Any, identity: AgentIdentity) -> Any:
    body_str = json.dumps(body, separators=(",", ":")) if body is not None else ""
    body_sha256 = to_hex(sha256(body_str.encode("utf-8")))
    timestamp = _now_iso()
    nonce = base64url_encode(secrets.token_bytes(16))
    digest = sha256(canonicalize({"method": method, "path": path, "timestamp": timestamp, "nonce": nonce, "bodySha256": body_sha256}).encode("utf-8"))
    sig = base64url_encode(sign_ed25519(sig_input("request", digest), identity.private_key))

    headers = {"og-key": identity.kid, "og-timestamp": timestamp, "og-nonce": nonce, "og-signature": sig}
    if identity.agent_id:
        headers["og-agent"] = identity.agent_id
    content = None
    if body is not None:
        headers["content-type"] = "application/json"
        content = body_str.encode("utf-8")

    res = client.request(method, f"{base_url}{path}", headers=headers, content=content)
    data = _read_json(res)
    if res.is_error:
        raise OpenGlassApiError(method, path, res.status_code, data)
    return data


def public_request(client: httpx.Client, base_url: str, method: str, path: str, body: Any = None) -> Any:
    headers = {}
    content = None
    if body is not None:
        headers["content-type"] = "application/json"
        content = json.dumps(body).encode("utf-8")
    res = client.request(method, f"{base_url}{path}", headers=headers, content=content)
    data = _read_json(res)
    if res.is_error:
        raise OpenGlassApiError(method, path, res.status_code, data)
    return data


def _read_json(res: httpx.Response) -> Any:
    try:
        return res.json()
    except ValueError:
        return None


def random_session_id() -> str:
    """A ``sessionId`` you choose (SPEC's ``ses_`` + 26-char Crockford base32)."""
    return "ses_" + "".join(_ALPHABET[b % 32] for b in os.urandom(26))
