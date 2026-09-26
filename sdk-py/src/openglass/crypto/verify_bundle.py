"""SPEC §7.6 / §12, ported from ``packages/db/src/crypto/verifyBundle.ts``. Runs the full
independent-verification algorithm offline — no network access, no trusting OpenGlass's
word for anything. ``trusted`` is a list of platform keys from OUTSIDE the bundle: pin
them yourself, or fetch ``{apiUrl}/.well-known/openglass-keys.json`` over TLS.
``bundle["platformKeys"]`` is only a hint and is never trusted on its own.

Handles both ``statement["kind"]`` values (``"session"`` — the default, for every record
issued before ``kind`` existed — and ``"attestation"``). Only step 2 (genesis) actually
differs; steps 1, 3, 4 are kind-agnostic by construction — see the field-reuse notes in
``packages/db/src/models/protocol.ts``.

Every check is recorded and execution continues regardless, so one pass reports every
problem rather than stopping at the first failure.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..types import Evidence, MessageEnvelope, ParticipantKeyRef, PlatformKey, RecordBundle, RecordParticipant, RecordStatement, Signature
from .canonical_json import canonicalize_to_bytes
from .ed25519 import base64url_decode
from .hash import hex_to_bytes, sha256, to_hex
from .verify import VerifyingKey, verify_signature


@dataclass
class VerifyError:
    code: str
    seq: int | None = None
    message: str = ""

    def __post_init__(self) -> None:
        if not self.message:
            self.message = self.code


@dataclass
class VerifyResult:
    valid: bool
    errors: list[VerifyError] = field(default_factory=list)


def verify_bundle(bundle: RecordBundle, trusted: list[PlatformKey]) -> VerifyResult:
    errors: list[VerifyError] = []

    def require(condition: bool, code: str, seq: int | None = None) -> None:
        if not condition:
            errors.append(VerifyError(code=code, seq=seq))

    evidence: Evidence = bundle["evidence"]
    statement: RecordStatement = bundle["record"]["statement"]
    kind = statement.get("kind", "session")

    def key_from_platform_key(k: PlatformKey) -> VerifyingKey:
        return VerifyingKey(alg=k["alg"], kid=k["kid"], public_key=base64url_decode(k["publicKey"]))

    def in_window(k: PlatformKey, at: str) -> bool:
        return at >= k["validFrom"] and (k["validUntil"] is None or at <= k["validUntil"])

    def platform_key(sig: Signature, at: str) -> VerifyingKey | None:
        for k in trusted:
            if k["kid"] == sig["kid"] and k["alg"] == sig["alg"] and in_window(k, at):
                return key_from_platform_key(k)
        return None

    def agent_key(ref: ParticipantKeyRef) -> VerifyingKey:
        return VerifyingKey(alg="Ed25519", kid=ref["kid"], public_key=base64url_decode(ref["publicKey"]))

    # 1. Record statement
    require(to_hex(sha256(canonicalize_to_bytes(statement))) == bundle["record"]["statementHash"], "statement_hash")
    require(
        verify_signature(
            platform_key(bundle["record"]["platformSignature"], statement["issuedAt"]),
            "record",
            hex_to_bytes(bundle["record"]["statementHash"]),
            bundle["record"]["platformSignature"],
        ),
        "record_signature",
    )
    require(to_hex(sha256(canonicalize_to_bytes(evidence))) == statement["evidenceSha256"], "evidence_hash")
    require(evidence["offer"] is not None if kind == "session" else evidence["open"] is not None, "kind_mismatch")

    # 2. Genesis — the one step that actually differs by kind.
    key_of: dict[str, ParticipantKeyRef]
    genesis_at: str

    if kind == "session":
        offer = evidence["offer"]
        accept = evidence["accept"]
        offer_signature = evidence["offerSignature"]
        accept_signature = evidence["acceptSignature"]
        assert offer is not None and accept is not None and offer_signature is not None and accept_signature is not None
        require(offer["sessionId"] == statement["sessionId"] and offer["mode"] == statement["mode"], "session_mismatch")

        a = offer["initiator"]
        b = accept["counterparty"]
        require(a["agentId"] != b["agentId"], "self_session")
        require(offer_signature["kid"] == a["kid"] and accept_signature["kid"] == b["kid"], "kid_mismatch")

        offer_hash_bytes = sha256(canonicalize_to_bytes(offer))
        require(verify_signature(agent_key(a), "offer", offer_hash_bytes, offer_signature), "offer_signature")
        require(accept["offerHash"] == to_hex(offer_hash_bytes), "offer_hash")
        require(accept["sessionId"] == offer["sessionId"], "session_mismatch")
        require(offer["counterparty"] is None or offer["counterparty"]["agentId"] == b["agentId"], "counterparty_mismatch")
        require(
            verify_signature(agent_key(b), "accept", sha256(canonicalize_to_bytes(accept)), accept_signature),
            "accept_signature",
        )

        genesis_hash_bytes = sha256(
            canonicalize_to_bytes(
                {"offer": offer, "offerSignature": offer_signature, "accept": accept, "acceptSignature": accept_signature}
            )
        )
        genesis_at = accept["acceptedAt"]
        key_of = {a["agentId"]: a, b["agentId"]: b}
        require(_participants_match(statement["participants"], a, b), "participants")
    else:
        open_stmt = evidence["open"]
        open_signature = evidence["openSignature"]
        assert open_stmt is not None and open_signature is not None
        require(open_stmt["attestationId"] == statement["sessionId"] and open_stmt["mode"] == statement["mode"], "session_mismatch")

        a = open_stmt["attestor"]
        require(open_signature["kid"] == a["kid"], "kid_mismatch")
        require(
            verify_signature(agent_key(a), "attestation_open", sha256(canonicalize_to_bytes(open_stmt)), open_signature),
            "open_signature",
        )

        genesis_hash_bytes = sha256(canonicalize_to_bytes({"open": open_stmt, "openSignature": open_signature}))
        genesis_at = open_stmt["createdAt"]
        key_of = {a["agentId"]: a}
        require(_attestor_matches(statement["participants"], a), "participants")

    g = to_hex(genesis_hash_bytes)
    require(g == evidence["genesisHash"] and g == statement["genesisHash"], "genesis_hash")
    require(
        verify_signature(platform_key(evidence["genesisSignature"], genesis_at), "genesis", genesis_hash_bytes, evidence["genesisSignature"]),
        "genesis_signature",
    )

    # 3. Chain — identical for both kinds; operates on the generic `prev`/`key_of` from step 2.
    prev = g
    last_received = genesis_at
    for i, m in enumerate(evidence["messages"]):
        env: MessageEnvelope = m["envelope"]
        seq = i + 1
        require(env["v"] == 1 and env["type"] == "openglass.message", "envelope_type", seq)
        require(env["sessionId"] == statement["sessionId"] and env["seq"] == seq, "seq", seq)
        require(env["prevHash"] == prev, "prev_hash", seq)

        k = key_of.get(env["sender"]["agentId"])
        require(k is not None and env["sender"]["kid"] == k["kid"] and m["signature"]["kid"] == k["kid"], "sender", seq)

        if statement["mode"] == "relay":
            require(env["payloadHash"] == to_hex(sha256(canonicalize_to_bytes(m.get("payload")))), "payload_hash", seq)
        else:
            require("payload" not in m, "payload_present", seq)

        h_bytes = sha256(hex_to_bytes(prev) + canonicalize_to_bytes(env))
        h = to_hex(h_bytes)
        require(h == m["hash"], "hash", seq)
        require(verify_signature(agent_key(k) if k else None, "message", h_bytes, m["signature"]), "message_signature", seq)

        countersign_digest = sha256(canonicalize_to_bytes({"hash": h, "agentSig": m["signature"]["sig"], "receivedAt": m["receivedAt"]}))
        require(
            verify_signature(
                platform_key(m["platformSignature"], m["receivedAt"]), "countersign", countersign_digest, m["platformSignature"]
            ),
            "countersignature",
            seq,
        )
        require(m["receivedAt"] >= last_received, "time_order", seq)

        prev = h
        last_received = m["receivedAt"]

    # 4. Head and close — identical for both kinds.
    require(statement["headSeq"] == len(evidence["messages"]) and statement["messageCount"] == len(evidence["messages"]), "head_seq")
    require(statement["headHash"] == (prev if evidence["messages"] else None), "head_hash")
    if evidence["close"]:
        c = evidence["close"]["statement"]
        k = key_of.get(statement["closedBy"]) if statement["closedBy"] else None
        require(
            k is not None and c["sessionId"] == statement["sessionId"] and c["headSeq"] == statement["headSeq"] and c["headHash"] == statement["headHash"],
            "close_statement",
        )
        require(
            verify_signature(agent_key(k) if k else None, "close", sha256(canonicalize_to_bytes(c)), evidence["close"]["signature"]),
            "close_signature",
        )
    else:
        require(statement["closedBy"] is None, "close_missing")

    return VerifyResult(valid=len(errors) == 0, errors=errors)


def _participants_match(participants: list[RecordParticipant], a: ParticipantKeyRef, b: ParticipantKeyRef) -> bool:
    init = next((p for p in participants if p["role"] == "initiator"), None)
    cp = next((p for p in participants if p["role"] == "counterparty"), None)
    return (
        init is not None
        and cp is not None
        and init["agentId"] == a["agentId"]
        and init["kid"] == a["kid"]
        and cp["agentId"] == b["agentId"]
        and cp["kid"] == b["kid"]
    )


def _attestor_matches(participants: list[RecordParticipant], a: ParticipantKeyRef) -> bool:
    att = next((p for p in participants if p["role"] == "attestor"), None)
    return att is not None and att["agentId"] == a["agentId"] and att["kid"] == a["kid"]
