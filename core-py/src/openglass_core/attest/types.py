"""Mirrors `openglass-sdk`'s internal (not yet part of its public export surface)
attestation wire shapes (SPEC §12.3) — see core-js's `attest/types.ts` for the TS
counterpart and the same rationale for duplicating rather than waiting on an SDK release.
"""

from __future__ import annotations

from typing import Any, Callable, List, Literal, Optional, TypedDict

from openglass import Mode, ParticipantKeyRef, Signature

from ..policy.types import PolicyEvent, RiskLevel, RuleMatch


class AttestationOpen(TypedDict):
    v: Literal[1]
    type: Literal["openglass.attestation_open"]
    attestationId: str
    mode: Mode
    purpose: str
    attestor: ParticipantKeyRef
    createdAt: str


class AttestationCloseStatement(TypedDict):
    v: Literal[1]
    type: Literal["openglass.close"]
    sessionId: str
    headSeq: int
    headHash: Optional[str]
    closedAt: str


AttestReason = Literal["below_threshold", "api_unreachable"]


class _AttestResultRequired(TypedDict):
    attested: bool
    risk: RiskLevel
    matches: List[RuleMatch]


class AttestResult(_AttestResultRequired, total=False):
    attestationId: str
    reason: AttestReason
    error: Any


class AttestOptions(TypedDict, total=False):
    base_url: str
    min_risk: RiskLevel
    mode: Mode
    idle_timeout_sec: int
    # Realignment R7 (docs/SPEC.md §13). Default "private" — explicit here rather than
    # left to the server's own default. A "private" request gracefully degrades to
    # "sealed" server-side if content encryption isn't configured.
    visibility: Literal["private", "sealed", "shared"]
    # Realignment R7: optional counterparty lookup (openglass-sdk's `guard()`) folded into
    # the attested payload alongside the policy verdict. Never blocks or suppresses the
    # attestation itself — attestations are a log of what happened, not a gate on it; it
    # only enriches the record with what was known about the counterparty at the time.
    # Omit `counterparty_agent_id` to skip this entirely (the common case).
    counterparty_agent_id: str
    on_unverified_domain: Literal["allow", "warn", "block"]
    on_new_counterparty: Literal["allow", "warn", "block"]
    retries: int
    on_error: Callable[[Exception], None]
    http_client: Any  # Optional[httpx.Client]; Any to avoid importing httpx just for the type here


__all__ = [
    "AttestationOpen",
    "AttestationCloseStatement",
    "AttestReason",
    "AttestResult",
    "AttestOptions",
    "PolicyEvent",
]
