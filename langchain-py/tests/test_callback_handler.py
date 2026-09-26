from __future__ import annotations

from fake_server import fake_client, failing_client
from langchain_core.tools import tool
from openglass import AgentIdentity, generate_ed25519_keypair
from openglass_core.policy import load_policy
from openglass_langchain import OpenGlassCallbackHandler

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


@tool
def transfer_funds(amount: float, recipient: str) -> str:
    """Transfer funds to a recipient."""
    return f"transferred {amount} to {recipient}"


@tool
def list_calendar() -> str:
    """List calendar events."""
    return "no events"


@tool
def flaky_tool() -> str:
    """Always fails."""
    raise ValueError("boom")


def test_attests_a_real_high_risk_tool_call() -> None:
    client, calls = fake_client()
    handler = OpenGlassCallbackHandler(make_identity(), POLICY, attest_options={"http_client": client})

    result = transfer_funds.invoke({"amount": 500, "recipient": "acme-vendor"}, config={"callbacks": [handler]})

    assert result == "transferred 500.0 to acme-vendor"
    paths = [c["path"] for c in calls]
    assert paths[0] == "/v1/attestations"
    assert paths[1].startswith("/v1/attestations/att_") and paths[1].endswith("/events")
    assert paths[2].startswith("/v1/attestations/att_") and paths[2].endswith("/close")


def test_does_not_attest_a_benign_tool_call() -> None:
    client, calls = fake_client()
    handler = OpenGlassCallbackHandler(make_identity(), POLICY, attest_options={"http_client": client})

    list_calendar.invoke({}, config={"callbacks": [handler]})

    assert calls == []


def test_attests_a_failed_high_risk_adjacent_tool_call() -> None:
    client, calls = fake_client()
    error_policy = load_policy(
        {
            "apiVersion": "openglass-policy/v1",
            "kind": "Policy",
            "metadata": {"name": "test"},
            "rules": [{"id": "errored", "risk": "high", "when": {"field": "attr:error.type", "op": "exists"}}],
        }
    )
    handler = OpenGlassCallbackHandler(make_identity(), error_policy, attest_options={"http_client": client})

    try:
        flaky_tool.invoke({}, config={"callbacks": [handler]})
    except ValueError:
        pass

    assert any(c["path"] == "/v1/attestations" for c in calls)


def test_fails_open_when_the_api_is_unreachable_and_does_not_break_the_tool_call() -> None:
    handler = OpenGlassCallbackHandler(
        make_identity(), POLICY, attest_options={"http_client": failing_client(), "retries": 1, "on_error": lambda e: None}
    )

    # the real tool call must still succeed even though attestation is failing open
    result = transfer_funds.invoke({"amount": 10, "recipient": "x"}, config={"callbacks": [handler]})
    assert result == "transferred 10.0 to x"
