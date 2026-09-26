"""SPEC §4.1 signed-request wrapper, ported from `openglass-sdk`'s own `http.py` (whose
`signed_request` isn't yet part of that package's public export surface) — the crypto
underneath (Ed25519 signing, canonical JSON, sha256) is entirely `openglass-sdk`'s;
this file only re-adds the thin httpx/header-building wrapper on top.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from openglass import AgentIdentity, base64url_encode, canonicalize, sha256, sig_input, sign_ed25519, to_hex


class OpenGlassApiError(Exception):
    def __init__(self, method: str, path: str, status: int, body: Any) -> None:
        super().__init__(f"{method} {path} -> {status}: {json.dumps(body)}")
        self.method = method
        self.path = path
        self.status = status
        self.body = body


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def signed_request(
    base_url: str,
    method: str,
    path: str,
    body: Any,
    identity: AgentIdentity,
    client: Optional[httpx.Client] = None,
) -> Any:
    """`client` is injectable so tests (and callers with their own connection pooling)
    can supply an `httpx.Client` bound to a `httpx.MockTransport` instead of a real
    server."""
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

    owns_client = client is None
    c = client or httpx.Client()
    try:
        res = c.request(method, f"{base_url}{path}", headers=headers, content=content)
    finally:
        if owns_client:
            c.close()

    try:
        data = res.json()
    except ValueError:
        data = None
    if res.is_error:
        raise OpenGlassApiError(method, path, res.status_code, data)
    return data
