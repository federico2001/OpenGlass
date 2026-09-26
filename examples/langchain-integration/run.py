"""
A LangChain agent's tool calls run exactly as they normally would — nothing
OpenGlass-aware about `transfer_funds`/`list_calendar_events` themselves. Registering
`OpenGlassCallbackHandler` is the only OpenGlass-specific line in this whole demo: it
classifies each call against the shipped default policy and opens a witnessed
attestation for the risky one. The benign call leaves no trace at all; the risky one
does, and we verify it independently at the end — the same idea as
examples/otel-integration, just for a LangChain callback handler instead of an OTel span
processor.

Run against a local stack:
    docker compose up --build -d --wait   # from the repo root
    cd examples/langchain-integration
    pip install -r requirements.txt
    python run.py

Or against any other OpenGlass deployment:
    OPENGLASS_BASE_URL=https://your-domain python run.py
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

import httpx
from langchain_core.tools import tool
from openglass import OpenGlassClient
from openglass_core.attest import signed_request
from openglass_core.policy import load_policy
from openglass_langchain import OpenGlassCallbackHandler

BASE_URL = os.environ.get("OPENGLASS_BASE_URL", "https://localhost")
RUN_ID = int(time.time())
POLICY_PATH = Path(__file__).resolve().parents[2] / "spec" / "openglass-policy" / "v1" / "default.yaml"

http = httpx.Client(verify=False, timeout=30.0)  # local stack's Caddy cert is self-signed


def heading(text: str) -> None:
    print(f"\n== {text} {'=' * max(0, 60 - len(text))}")


def mailpit_reachable() -> bool:
    try:
        return http.get(f"{BASE_URL}/mailpit/api/v1/messages", timeout=2.0).status_code == 200
    except httpx.HTTPError:
        return False


def claim_via_mailpit(claim_url: str, owner_email: str) -> None:
    """Stands in for a human owner opening `claim_url`, using the local stack's Mailpit —
    the same trick examples/witnessed-negotiation uses in TS."""
    token = claim_url.split("/claim/")[1]
    http.post(f"{BASE_URL}/v1/auth/email", json={"email": owner_email, "redirectTo": f"/claim/{token}"}, headers={"origin": BASE_URL})

    message_id = None
    for _ in range(10):
        time.sleep(0.4)
        mail = http.get(f"{BASE_URL}/mailpit/api/v1/messages").json()
        message_id = next((m["ID"] for m in mail["messages"] if m["To"][0]["Address"] == owner_email), None)
        if message_id:
            break
    if not message_id:
        raise RuntimeError(f"magic-link email for {owner_email} never arrived in Mailpit")

    full = http.get(f"{BASE_URL}/mailpit/api/v1/message/{message_id}").json()
    match = re.search(r"https?://\S+/v1/auth/verify\?token=\S+", full["Text"])
    if not match:
        raise RuntimeError("sign-in link not found in the magic-link email body")

    verify_res = http.get(match.group(0), follow_redirects=False)
    cookie_match = re.search(r"og_session=[^;]+", verify_res.headers.get("set-cookie", ""))
    if not cookie_match:
        raise RuntimeError("signing in did not set an og_session cookie")

    accept_res = http.post(
        f"{BASE_URL}/v1/claims/{token}/accept", json={}, headers={"origin": BASE_URL, "cookie": cookie_match.group(0)}
    )
    accept_res.raise_for_status()


def claim_manually(claim_url: str) -> None:
    print("  Open this and confirm the key fingerprint matches:")
    print(f"    {claim_url}")
    input("  Press Enter once claimed... ")


def wait_for_attestation_record(client: OpenGlassClient, purpose_contains: str, timeout_s: float = 15.0) -> str:
    identity = client.identity
    assert identity is not None
    deadline = time.time() + timeout_s
    while True:
        result = signed_request(BASE_URL, "GET", "/v1/attestations", None, identity, http)
        found = next((a for a in result["items"] if purpose_contains in a["purpose"]), None)
        if found and found["status"] == "closed" and found["recordId"]:
            return str(found["recordId"])
        if time.time() >= deadline:
            raise RuntimeError(f'Timed out waiting for an attestation matching "{purpose_contains}" to close')
        time.sleep(1.0)


@tool
def list_calendar_events() -> str:
    """List the user's upcoming calendar events."""
    return "No events in the next 7 days."


@tool
def transfer_funds(amount_usd: float, recipient: str) -> str:
    """Transfer funds to a recipient."""
    return f"Transferred ${amount_usd:.2f} to {recipient}."


def main() -> None:
    print(f"OpenGlass LangChain integration demo — target: {BASE_URL}")
    use_mailpit = mailpit_reachable()
    print("Mailpit found — claiming the agent automatically." if use_mailpit else "No Mailpit — you'll need to claim the agent by hand.")

    heading("Register and claim (one agent — attestations are one-party, SPEC §12)")
    client = OpenGlassClient(base_url=BASE_URL, http_client=http)
    result = client.register_agent(name="Ops Assistant Bot", description="Handles calendar and finance tool calls for an internal ops team.")
    agent = result["agent"]
    print(f"Agent registered: {agent['id']} ({agent['fingerprint']})")
    if use_mailpit:
        claim_via_mailpit(result["claim"]["url"], f"ops-py-{RUN_ID}@example.com")
    else:
        claim_manually(result["claim"]["url"])
    client.wait_until_claimed(timeout_s=15.0)
    print("Agent claimed.")

    heading("Wire up the LangChain callback handler — the only OpenGlass-specific line")
    policy = load_policy(POLICY_PATH.read_text())
    assert client.identity is not None
    handler = OpenGlassCallbackHandler(client.identity, policy, attest_options={"base_url": BASE_URL, "http_client": http})
    print(f"Loaded policy \"{policy['metadata']['name']}\" ({len(policy['rules'])} rules) from spec/openglass-policy/v1/default.yaml")

    heading("Run two ordinary-looking tool calls, through a real LangChain callback")
    list_calendar_events.invoke({}, config={"callbacks": [handler]})
    print('  ran "list_calendar_events" (benign — no OpenGlass call at all)')

    transfer_funds.invoke({"amount_usd": 500, "recipient": "acme-vendor"}, config={"callbacks": [handler]})
    print("  ran \"transfer_funds\" (matches the default policy's financial-transaction rule)")

    heading("Waiting for the platform to issue a record for the risky call")
    record_id = wait_for_attestation_record(client, "financial-transaction")
    print(f"Record issued: {record_id}")

    heading("Verify — independently, with no trust in OpenGlass required")
    bundle = client.get_record_bundle(record_id)
    local_result = client.verify(bundle)
    print(f"Local verification (re-derives every hash and checks every signature): valid={local_result['valid']}")
    if not local_result["valid"]:
        print("  errors:", local_result["errors"])
    print(f"Record kind: {bundle['record']['statement'].get('kind', 'session')} (this one: \"attestation\" — one agent, no counterparty)")

    print(f"\nRecord bundle: {BASE_URL}/v1/records/{record_id}/bundle")
    print("The benign tool call left no trace at all — only the risky one was worth witnessing.")


if __name__ == "__main__":
    main()
