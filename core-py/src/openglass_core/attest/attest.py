from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional, TypeVar

import httpx
from openglass import AgentIdentity, Signature, base64url_encode, canonicalize, canonicalize_to_bytes, sha256, sig_input, sign_ed25519, to_hex

from ..policy.evaluate import evaluate
from ..policy.types import Policy, PolicyEvent, PolicyResult, RiskLevel
from .http_sign import signed_request
from .types import AttestationCloseStatement, AttestationOpen, AttestOptions, AttestResult

_RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
_DEFAULT_BASE_URL = "https://openglass.glass"
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32, no I/L/O/U

T = TypeVar("T")


def _random_ulid() -> str:
    return "".join(_ALPHABET[b % 32] for b in secrets.token_bytes(26))


def _now_iso() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _with_retry(fn: Callable[[], T], attempts: int) -> T:
    last_err: Optional[BaseException] = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as err:  # noqa: BLE001 - deliberately broad: any transport failure is retried
            last_err = err
            if i < attempts - 1:
                time.sleep(0.2 * (2**i))
    assert last_err is not None
    raise last_err


def _sign_purpose(purpose: str, obj: Any, identity: AgentIdentity) -> Signature:
    digest = sha256(canonicalize(obj).encode("utf-8"))
    return {"alg": "Ed25519", "kid": identity.kid, "sig": base64url_encode(sign_ed25519(sig_input(purpose, digest), identity.private_key))}


def _default_on_error(error: Exception) -> None:
    print(f"[openglass-core] attestation failed, continuing without one: {error}")


def evaluate_and_attest(identity: AgentIdentity, policy: Policy, event: PolicyEvent, opts: Optional[AttestOptions] = None) -> AttestResult:
    """The one primitive every integration calls. See core-js's `attest.ts` for the full
    design rationale (fail-open, retry, one attestation per risky event) — this is its
    Python port, synchronous to match `openglass-sdk`'s own client."""
    o: AttestOptions = opts or {}
    verdict: PolicyResult = evaluate(policy, event)
    min_risk: RiskLevel = o.get("min_risk", "high")
    if _RISK_ORDER[verdict["risk"]] < _RISK_ORDER[min_risk]:
        return {"attested": False, "reason": "below_threshold", "risk": verdict["risk"], "matches": verdict["matches"]}

    base_url = o.get("base_url", _DEFAULT_BASE_URL)
    mode = o.get("mode", "notary")
    retries = o.get("retries", 3)
    client: Optional[httpx.Client] = o.get("http_client")
    on_error = o.get("on_error", _default_on_error)

    try:
        attestation_id = f"att_{_random_ulid()}"
        open_stmt: AttestationOpen = {
            "v": 1,
            "type": "openglass.attestation_open",
            "attestationId": attestation_id,
            "mode": mode,
            "purpose": ", ".join(m["id"] for m in verdict["matches"]) or "openglass-policy match",
            "attestor": {"agentId": identity.agent_id or "", "kid": identity.kid, "publicKey": base64url_encode(identity.public_key)},
            "createdAt": _now_iso(),
        }
        open_signature = _sign_purpose("attestation_open", open_stmt, identity)
        opened = _with_retry(
            lambda: signed_request(base_url, "POST", "/v1/attestations", {"open": open_stmt, "openSignature": open_signature, "idleTimeoutSec": o.get("idle_timeout_sec")}, identity, client),
            retries,
        )
        genesis_hash: str = opened["attestation"]["genesisHash"]

        verdict_payload = {"event": event, "verdict": verdict}
        payload = verdict_payload if mode == "relay" else None
        payload_hash = to_hex(sha256(canonicalize_to_bytes(verdict_payload)))
        envelope = {
            "v": 1,
            "type": "openglass.message",
            "sessionId": attestation_id,
            "seq": 1,
            "prevHash": genesis_hash,
            "sender": {"agentId": identity.agent_id, "kid": identity.kid},
            "contentType": "application/json",
            "payloadHash": payload_hash,
            "sentAt": _now_iso(),
        }
        hash_bytes = sha256(bytes.fromhex(genesis_hash) + canonicalize_to_bytes(envelope))
        event_hash = to_hex(hash_bytes)
        signature: Signature = {"alg": "Ed25519", "kid": identity.kid, "sig": base64url_encode(sign_ed25519(sig_input("message", hash_bytes), identity.private_key))}
        appended = _with_retry(
            lambda: signed_request(base_url, "POST", f"/v1/attestations/{attestation_id}/events", {"envelope": envelope, "hash": event_hash, "signature": signature, "payload": payload}, identity, client),
            retries,
        )
        head = appended["head"]

        statement: AttestationCloseStatement = {"v": 1, "type": "openglass.close", "sessionId": attestation_id, "headSeq": head["seq"], "headHash": head["hash"], "closedAt": _now_iso()}
        close_signature = _sign_purpose("close", statement, identity)
        _with_retry(lambda: signed_request(base_url, "POST", f"/v1/attestations/{attestation_id}/close", {"statement": statement, "signature": close_signature}, identity, client), retries)

        return {"attested": True, "attestationId": attestation_id, "risk": verdict["risk"], "matches": verdict["matches"]}
    except Exception as error:  # noqa: BLE001 - fail open: never propagate, always report
        on_error(error)
        return {"attested": False, "reason": "api_unreachable", "risk": verdict["risk"], "matches": verdict["matches"], "error": error}


def witness_if_risky(
    identity: AgentIdentity,
    policy: Policy,
    event: PolicyEvent,
    action: Callable[[], T],
    opts: Optional[AttestOptions] = None,
) -> tuple[T, AttestResult]:
    """Attests first (so the record exists even if `action` later raises), then runs
    `action`. See core-js's `witnessIfRisky` for the same rationale."""
    attestation = evaluate_and_attest(identity, policy, event, opts)
    result = action()
    return result, attestation
