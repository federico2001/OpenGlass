"""Live-stack integration test: register -> get claimed -> offer/accept a session -> send
a witnessed message -> close -> verify. Runs against ``https://localhost`` (the local
docker-compose stack from the repo root: ``docker compose up -d --wait``), which uses a
self-signed cert in dev.

Skips itself (rather than failing) when the stack isn't reachable, so `pytest` stays green
on a fresh checkout or in CI without the stack running. Set OPENGLASS_TEST_BASE_URL to
point at a different environment.
"""

from __future__ import annotations

import os
import re
import time

import httpx
import pytest

from openglass import OpenGlassClient

BASE_URL = os.environ.get("OPENGLASS_TEST_BASE_URL", "https://localhost")


def _reachable() -> bool:
    try:
        res = httpx.get(f"{BASE_URL}/health", verify=False, timeout=2.0)
        return res.status_code == 200
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not _reachable(), reason=f"OpenGlass stack not reachable at {BASE_URL}")


def _claim_agent(claim_url: str) -> None:
    """Stands in for a human owner opening the claim link, using the same public HTTP
    surface the claim page itself uses, so the whole round trip can run unattended."""
    token = claim_url.rsplit("/claim/", 1)[1]
    email = f"sdk-py-test-{int(time.time() * 1000)}@example.com"
    with httpx.Client(verify=False, timeout=10.0) as http:
        http.post(
            f"{BASE_URL}/v1/auth/email",
            headers={"content-type": "application/json", "origin": BASE_URL},
            json={"email": email, "redirectTo": f"/claim/{token}"},
        )
        time.sleep(0.7)
        mail = http.get(f"{BASE_URL}/mailpit/api/v1/messages").json()
        msg = next((m for m in mail["messages"] if m["To"][0]["Address"] == email), None)
        assert msg is not None, "magic link email not found in mailpit — is mailpit reachable at /mailpit?"
        full = http.get(f"{BASE_URL}/mailpit/api/v1/message/{msg['ID']}").json()
        match = re.search(r"https://\S+/v1/auth/verify\?token=\S+", full["Text"])
        assert match is not None, "verify link not found in email body"
        verify_res = http.get(match.group(0), follow_redirects=False)
        set_cookie = verify_res.headers.get("set-cookie", "")
        cookie_match = re.search(r"og_session=[^;]+", set_cookie)
        assert cookie_match is not None, "no og_session cookie set after verify"
        cookie = cookie_match.group(0)
        accept_res = http.post(
            f"{BASE_URL}/v1/claims/{token}/accept",
            headers={"content-type": "application/json", "origin": BASE_URL, "cookie": cookie},
            content="{}",
        )
        assert accept_res.status_code == 200, f"claim accept failed: {accept_res.status_code} {accept_res.text}"


def test_full_witnessed_session_round_trip() -> None:
    with OpenGlassClient(base_url=BASE_URL, http_client=httpx.Client(verify=False, timeout=30.0)) as initiator, OpenGlassClient(
        base_url=BASE_URL, http_client=httpx.Client(verify=False, timeout=30.0)
    ) as counterparty:
        init_result = initiator.register_agent(name="sdk-py integration test (initiator)", description="Created by sdk-py's own test suite.")
        cp_result = counterparty.register_agent(name="sdk-py integration test (counterparty)", description="Created by sdk-py's own test suite.")
        assert init_result["agent"]["status"] == "unclaimed"

        _claim_agent(init_result["claim"]["url"])
        _claim_agent(cp_result["claim"]["url"])

        init_me = initiator.wait_until_claimed(timeout_s=15)
        assert init_me["status"] == "active"
        assert init_me["claimed"] is True

        offer_result = initiator.offer_session(purpose="sdk-py integration test session.", counterparty_agent_id=cp_result["agent"]["id"])
        session = offer_result["session"]
        assert session["status"] == "pending"

        deadline = time.monotonic() + 15
        invite = None
        while time.monotonic() < deadline:
            pending = [i for i in counterparty.list_invites() if i["sessionId"] == session["id"] and i["status"] == "pending"]
            if pending:
                invite = pending[0]
                break
            time.sleep(1)
        assert invite is not None, "invite never appeared for counterparty"

        accept_result = counterparty.accept_invite(invite["id"])
        assert accept_result["session"]["status"] == "active"
        assert accept_result["session"]["genesisHash"]

        initiator.wait_for_active(session["id"], timeout_s=10)

        msg_result = initiator.send_message(session["id"], {"text": "Hello from sdk-py."})
        assert msg_result["head"]["seq"] == 1

        initiator.close_session(session["id"])
        record_id = initiator.wait_for_record(session["id"], timeout_s=20)
        assert record_id

        bundle = initiator.get_record_bundle(record_id)
        local_result = initiator.verify(bundle)
        assert local_result.errors == []
        assert local_result.valid is True

        remote_result = initiator.verify_remote(bundle)
        assert remote_result["valid"] is True
