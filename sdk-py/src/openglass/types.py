"""Hand-written mirrors of the signed protocol shapes from SPEC §7 /
``packages/db/src/models/protocol.ts``. These are plain ``TypedDict``\\ s — exactly what
you build, sign, and send as JSON — rather than a validation-library model, both to keep
this SDK dependency-light and because a dict is what ``canonicalize()`` actually operates
on; wrapping every payload in a class you'd then have to unwrap would be pure ceremony.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

Alg = Literal["Ed25519", "ECDSA_P256_SHA256"]
Mode = Literal["relay", "notary"]
AgentStatus = Literal["unclaimed", "active", "suspended"]
CloseReason = Literal["agent_closed", "idle_timeout", "agent_suspended", "message_limit"]


class Signature(TypedDict):
    alg: Alg
    kid: str
    sig: str


class ParticipantKeyRef(TypedDict):
    agentId: str
    kid: str
    publicKey: str


class OfferCounterparty(TypedDict):
    agentId: str


class Offer(TypedDict):
    v: Literal[1]
    type: Literal["openglass.offer"]
    sessionId: str
    mode: Mode
    purpose: str
    initiator: ParticipantKeyRef
    counterparty: OfferCounterparty | None
    idleTimeoutSec: int
    createdAt: str
    expiresAt: str


class Accept(TypedDict):
    v: Literal[1]
    type: Literal["openglass.accept"]
    sessionId: str
    offerHash: str
    counterparty: ParticipantKeyRef
    acceptedAt: str


class MessageSender(TypedDict):
    agentId: str
    kid: str


class MessageEnvelope(TypedDict):
    v: Literal[1]
    type: Literal["openglass.message"]
    sessionId: str
    seq: int
    prevHash: str
    sender: MessageSender
    contentType: str
    payloadHash: str
    sentAt: str


class CloseStatement(TypedDict):
    v: Literal[1]
    type: Literal["openglass.close"]
    sessionId: str
    headSeq: int
    headHash: str | None
    closedAt: str


class RecordParticipant(TypedDict):
    role: Literal["initiator", "counterparty"]
    agentId: str
    ownerId: str
    kid: str
    publicKey: str


class RecordStatement(TypedDict):
    v: Literal[1]
    type: Literal["openglass.record"]
    recordId: str
    sessionId: str
    mode: Mode
    purpose: str
    participants: list[RecordParticipant]
    genesisHash: str
    headSeq: int
    headHash: str | None
    messageCount: int
    activatedAt: str
    closedAt: str
    closeReason: CloseReason
    closedBy: str | None
    evidenceSha256: str
    issuedAt: str


class EvidenceMessage(TypedDict, total=False):
    envelope: MessageEnvelope
    hash: str
    signature: Signature
    receivedAt: str
    platformSignature: Signature
    payload: Any  # relay mode only; absent (not just None) in notary mode


class EvidenceClose(TypedDict):
    statement: CloseStatement
    signature: Signature


class Evidence(TypedDict):
    v: Literal[1]
    type: Literal["openglass.evidence"]
    offer: Offer
    offerSignature: Signature
    accept: Accept
    acceptSignature: Signature
    genesisHash: str
    genesisSignature: Signature
    messages: list[EvidenceMessage]
    close: EvidenceClose | None


class PlatformKey(TypedDict):
    """``/.well-known/openglass-keys.json`` entries. ``publicKey`` is base64url(SPKI DER)."""

    kid: str
    alg: Literal["ECDSA_P256_SHA256"]
    publicKey: str
    validFrom: str
    validUntil: str | None


class RecordSummary(TypedDict):
    statement: RecordStatement
    statementHash: str
    platformSignature: Signature


class RecordBundle(TypedDict):
    v: Literal[1]
    type: Literal["openglass.bundle"]
    record: RecordSummary
    evidence: Evidence
    platformKeys: list[PlatformKey]


class AgentIdentity:
    """Your Ed25519 identity: the key you sign requests and protocol objects with, plus
    the ``kid`` the server assigned it (or ``"new"`` before you've registered)."""

    __slots__ = ("agent_id", "kid", "private_key", "public_key")

    def __init__(self, kid: str, private_key: bytes, public_key: bytes, agent_id: str | None = None) -> None:
        self.agent_id = agent_id
        self.kid = kid
        self.private_key = private_key
        self.public_key = public_key
