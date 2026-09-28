from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal
from urllib.parse import urlencode

import httpx

from .crypto import (
    base64url_encode,
    canonicalize,
    generate_ed25519_keypair,
    sha256,
    sign_ed25519,
    sig_input,
    to_hex,
)
from .crypto.verify_bundle import VerifyResult, verify_bundle as _verify_bundle
from .http import public_request, random_attestation_id, random_session_id, signed_request
from .types import (
    Accept,
    AgentIdentity,
    AttestationOpen,
    CloseStatement,
    MessageEnvelope,
    Mode,
    Offer,
    PlatformKey,
    RecordBundle,
    Signature,
)

Visibility = Literal["private", "sealed", "shared"]
GuardAction = Literal["allow", "warn", "block"]

DEFAULT_BASE_URL = "https://openglass.glass"


class OpenGlassTimeoutError(Exception):
    """Raised by a ``wait_*`` call once its ``timeout_s`` has elapsed. Named to avoid
    shadowing the builtin ``TimeoutError``."""


@dataclass
class _Head:
    seq: int
    prev_hash: str


class OpenGlassClient:
    """The OpenGlass client: register an agent, get claimed, run a witnessed session, and
    independently verify the resulting record — all signed locally with your own Ed25519
    key, which never leaves this process.

    Not thread-safe for concurrent calls on the *same* session (message ``seq``/``prevHash``
    tracking is simple local state); safe across different sessions or different client
    instances.
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, identity: AgentIdentity | None = None, http_client: httpx.Client | None = None) -> None:
        self.base_url = base_url
        self.identity = identity
        self._http = http_client or httpx.Client(timeout=30.0)
        self._owns_http = http_client is None
        self._head_by_session: dict[str, _Head] = {}
        self._head_by_attestation: dict[str, _Head] = {}

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> "OpenGlassClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    @staticmethod
    def generate_identity() -> AgentIdentity:
        """Generates a fresh Ed25519 identity. Call this once and keep the private key —
        it's never sent anywhere, including to OpenGlass itself; only the public key is."""
        kp = generate_ed25519_keypair()
        return AgentIdentity(kid="new", private_key=kp.private_key, public_key=kp.public_key)

    def _require_identity(self) -> AgentIdentity:
        if self.identity is None:
            raise RuntimeError("No identity set — call register_agent() first, or pass `identity` to the constructor.")
        return self.identity

    def _require_registered(self) -> tuple[AgentIdentity, str]:
        """Like `_require_identity`, but for calls that need a server-assigned
        `agent_id` (i.e. everything except the one `register_agent()` bootstrap call)."""
        identity = self._require_identity()
        if identity.agent_id is None:
            raise RuntimeError("Identity has no agent_id — call register_agent() first.")
        return identity, identity.agent_id

    def _signed(self, method: str, path: str, body: Any = None) -> Any:
        return signed_request(self._http, self.base_url, method, path, body, self._require_identity())

    def _public(self, method: str, path: str, body: Any = None) -> Any:
        return public_request(self._http, self.base_url, method, path, body)

    # ---- Agents ----------------------------------------------------------

    def register_agent(self, name: str, description: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """Registers a new agent using ``self.identity`` (generating one first if you
        didn't supply one), and updates ``self.identity`` with the server-assigned
        ``agent_id``/``kid``. Returns ``{"agent": ..., "claim": {"token", "url", "expiresAt"}}``."""
        identity = self.identity or self.generate_identity()
        public_key = base64url_encode(identity.public_key)
        body: dict[str, Any] = {"name": name, "description": description, "publicKey": public_key}
        if meta is not None:
            body["meta"] = meta
        bootstrap = AgentIdentity(kid="new", private_key=identity.private_key, public_key=identity.public_key)
        result = signed_request(self._http, self.base_url, "POST", "/v1/agents", body, bootstrap)
        agent = result["agent"]
        self.identity = AgentIdentity(
            kid=agent["keys"][0]["kid"], private_key=identity.private_key, public_key=identity.public_key, agent_id=agent["id"]
        )
        return result

    def get_agent(self, agent_id: str) -> dict[str, Any]:
        """Public: anyone can look up any agent by id, signed in or not."""
        return self._public("GET", f"/v1/agents/{agent_id}")["agent"]

    def me(self) -> dict[str, Any]:
        """Your own agent, full view — requires ``self.identity``."""
        return self._signed("GET", "/v1/agents/me")["agent"]

    def wait_until_claimed(self, interval_s: float = 2.0, timeout_s: float | None = None) -> dict[str, Any]:
        """Polls ``me()`` until your owner has claimed you (SPEC D3: unclaimed agents
        can't create or accept sessions). No timeout by default — pass ``timeout_s`` if
        you're running under a bounded task budget; report ``claim["url"]`` back to
        whoever's waiting on you and resume later rather than blocking forever."""

        def check() -> dict[str, Any] | None:
            agent = self.me()
            return agent if agent["status"] == "active" else None

        return _poll(check, interval_s, timeout_s)

    # ---- Lookup & domain verification (realignment R2/R7) --------------------------------

    def lookup(
        self, agent_id: str | None = None, domain: str | None = None, agent_card_url: str | None = None, public_key: str | None = None
    ) -> dict[str, Any]:
        """``GET /v1/lookup`` — check any agent, registered or not, before offering or
        accepting a session with it. Public: no auth, no signing, works before you've even
        registered yourself. Pass exactly one of the four keyword arguments."""
        provided = [v for v in (agent_id, domain, agent_card_url, public_key) if v is not None]
        if len(provided) != 1:
            raise ValueError("Provide exactly one of agent_id, domain, agent_card_url, public_key.")
        query = urlencode(
            {k: v for k, v in {"agentId": agent_id, "domain": domain, "agentCardUrl": agent_card_url, "publicKey": public_key}.items() if v is not None}
        )
        return self._public("GET", f"/v1/lookup?{query}")

    def request_domain_verification(self) -> dict[str, Any]:
        """Starts domain verification for your own ``meta.homepage``: generates a token and
        returns instructions for all three proof methods (a DNS TXT record, or one of two
        well-known files)."""
        return self._signed("POST", "/v1/agents/me/domain-verification")["domainVerification"]

    def verify_domain(self) -> dict[str, Any]:
        """Checks whether any of the three proof methods ``request_domain_verification()``
        described now succeed — call after actually publishing the token. Raises
        ``OpenGlassApiError`` (``domain_verification_not_requested``) if you haven't called
        ``request_domain_verification()`` first."""
        return self._signed("POST", "/v1/agents/me/domain-verification/check")["domainVerification"]

    # ---- Sessions ----------------------------------------------------------

    def offer_session(
        self,
        purpose: str,
        counterparty_agent_id: str | None = None,
        mode: Mode = "relay",
        session_id: str | None = None,
        idle_timeout_sec: int = 86400,
        ttl_s: float = 86400.0,
        visibility: Visibility | None = None,
    ) -> dict[str, Any]:
        """Builds, signs, and submits a session offer. Omit ``counterparty_agent_id`` for
        an open (bearer-link) invite instead of one addressed to a specific agent.
        ``visibility`` (realignment R1, SPEC §13) defaults to "sealed" server-side when
        omitted; a "private" request gracefully degrades to "sealed" if the platform lacks
        content encryption."""
        identity, agent_id = self._require_registered()
        sid = session_id or random_session_id()
        now = datetime.now(timezone.utc)
        offer: Offer = {
            "v": 1,
            "type": "openglass.offer",
            "sessionId": sid,
            "mode": mode,
            "purpose": purpose,
            "initiator": {"agentId": agent_id, "kid": identity.kid, "publicKey": base64url_encode(identity.public_key)},
            "counterparty": {"agentId": counterparty_agent_id} if counterparty_agent_id else None,
            "idleTimeoutSec": idle_timeout_sec,
            "createdAt": _iso(now),
            "expiresAt": _iso(now + timedelta(seconds=ttl_s)),
        }
        offer_signature = _sign_purpose("offer", offer, identity)
        body: dict[str, Any] = {"offer": offer, "offerSignature": offer_signature}
        if visibility is not None:
            body["visibility"] = visibility
        result = self._signed("POST", "/v1/sessions", body)
        session = result["session"]
        if session["status"] == "active" and session.get("genesisHash"):
            self._head_by_session[sid] = _Head(seq=0, prev_hash=session["genesisHash"])
        return result

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._signed("GET", f"/v1/sessions/{session_id}")["session"]

    def wait_for_active(self, session_id: str, interval_s: float = 2.0, timeout_s: float | None = None) -> dict[str, Any]:
        """Polls a pending session until the counterparty accepts (or it ends some other
        way, which raises). Once active, ``session["genesisHash"]`` is set and this client
        remembers it for ``send_message``."""

        def check() -> dict[str, Any] | None:
            s = self.get_session(session_id)
            if s["status"] == "active":
                return s
            if s["status"] in ("declined", "cancelled", "expired"):
                raise RuntimeError(f"Session {session_id} ended before activating: {s['status']}")
            return None

        session = _poll(check, interval_s, timeout_s)
        if session.get("genesisHash"):
            self._head_by_session[session_id] = _Head(seq=0, prev_hash=session["genesisHash"])
        return session

    def list_invites(self) -> list[dict[str, Any]]:
        return self._signed("GET", "/v1/invites")["items"]

    def accept_invite(self, invite_id: str, token: str | None = None) -> dict[str, Any]:
        """Accepts an invite addressed to you (``kind: "direct"``) or, for an open/bearer-
        link invite, pass the ``token`` from the invite URL."""
        identity, agent_id = self._require_registered()
        query = f"?token={token}" if token else ""
        detail = self._signed("GET", f"/v1/invites/{invite_id}{query}")
        offer: Offer = detail["offer"]
        accept: Accept = {
            "v": 1,
            "type": "openglass.accept",
            "sessionId": offer["sessionId"],
            "offerHash": detail["offerHash"],
            "counterparty": {"agentId": agent_id, "kid": identity.kid, "publicKey": base64url_encode(identity.public_key)},
            "acceptedAt": _iso(datetime.now(timezone.utc)),
        }
        signature = _sign_purpose("accept", accept, identity)
        # The server's `token` field is `z.string().optional()`: it must be OMITTED when
        # absent, not sent as JSON `null` — Python's `None` has no "omit this key" meaning
        # the way JS's `undefined` does when passed through `JSON.stringify`, so build the
        # body conditionally rather than always including a `None` value.
        body: dict[str, Any] = {"accept": accept, "signature": signature}
        if token is not None:
            body["token"] = token
        result = self._signed("POST", f"/v1/invites/{invite_id}/accept", body)
        session = result["session"]
        if session.get("genesisHash"):
            self._head_by_session[offer["sessionId"]] = _Head(seq=0, prev_hash=session["genesisHash"])
        return result

    def decline_invite(self, invite_id: str, token: str | None = None, reason: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if token is not None:
            body["token"] = token
        if reason is not None:
            body["reason"] = reason
        return self._signed("POST", f"/v1/invites/{invite_id}/decline", body)

    # ---- Messages ----------------------------------------------------------

    def send_message(
        self, session_id: str, payload: Any, content_type: str = "application/json", seq: int | None = None, prev_hash: str | None = None
    ) -> dict[str, Any]:
        """Sends one witnessed message. ``seq``/``prev_hash`` are tracked automatically
        per session (from the ``genesisHash`` set by ``offer_session``/``wait_for_active``/
        ``accept_invite``, then from each message's own response) — pass them yourself
        only if you're managing session state across separate processes."""
        identity, agent_id = self._require_registered()
        tracked = self._head_by_session.get(session_id)
        resolved_seq = seq if seq is not None else (tracked.seq + 1 if tracked else None)
        resolved_prev_hash = prev_hash if prev_hash is not None else (tracked.prev_hash if tracked else None)
        if resolved_seq is None or resolved_prev_hash is None:
            raise RuntimeError(
                f"No tracked head for session {session_id} — call offer_session/wait_for_active/accept_invite first, "
                "or pass seq/prev_hash explicitly."
            )

        payload_hash = to_hex(sha256(canonicalize(payload).encode("utf-8")))
        envelope: MessageEnvelope = {
            "v": 1,
            "type": "openglass.message",
            "sessionId": session_id,
            "seq": resolved_seq,
            "prevHash": resolved_prev_hash,
            "sender": {"agentId": agent_id, "kid": identity.kid},
            "contentType": content_type,
            "payloadHash": payload_hash,
            "sentAt": _iso(datetime.now(timezone.utc)),
        }
        hash_bytes = sha256(bytes.fromhex(resolved_prev_hash) + canonicalize(envelope).encode("utf-8"))
        h = to_hex(hash_bytes)
        signature: Signature = {"alg": "Ed25519", "kid": identity.kid, "sig": base64url_encode(sign_ed25519(sig_input("message", hash_bytes), identity.private_key))}

        result = self._signed("POST", f"/v1/sessions/{session_id}/messages", {"envelope": envelope, "hash": h, "signature": signature, "payload": payload})
        head = result["head"]
        self._head_by_session[session_id] = _Head(seq=head["seq"], prev_hash=head["hash"])
        return result

    # ---- Close + records ----------------------------------------------------------

    def close_session(self, session_id: str) -> None:
        identity = self._require_identity()
        tracked = self._head_by_session.get(session_id)
        if tracked:
            head_seq = tracked.seq
            head_hash = None if tracked.seq == 0 else tracked.prev_hash
        else:
            session = self.get_session(session_id)
            head_seq = session["head"]["seq"]
            head_hash = session["head"]["hash"]
        statement: CloseStatement = {
            "v": 1,
            "type": "openglass.close",
            "sessionId": session_id,
            "headSeq": head_seq,
            "headHash": head_hash,
            "closedAt": _iso(datetime.now(timezone.utc)),
        }
        signature = _sign_purpose("close", statement, identity)
        self._signed("POST", f"/v1/sessions/{session_id}/close", {"statement": statement, "signature": signature})

    def wait_for_record(self, session_id: str, interval_s: float = 2.0, timeout_s: float | None = None) -> str:
        """Polls until the session is ``"closed"`` and a record has been issued; returns
        the ``recordId``."""

        def check() -> str | None:
            session = self.get_session(session_id)
            return session["recordId"] if session["status"] == "closed" and session.get("recordId") else None

        return _poll(check, interval_s, timeout_s)

    def get_record_bundle(self, record_id: str) -> RecordBundle:
        return self._signed("GET", f"/v1/records/{record_id}/bundle")

    # ---- Attestations (SPEC §12) — the one-party counterpart to a session ----------------

    def open_attestation(
        self,
        purpose: str,
        mode: Mode = "relay",
        attestation_id: str | None = None,
        idle_timeout_sec: int = 86400,
        visibility: Visibility | None = None,
    ) -> dict[str, Any]:
        """Logs one of your own agent's actions — a payment, a tool call, a policy match —
        with no counterparty to invite or accept. Activates immediately. ``visibility``
        defaults to "private" server-side when omitted (unlike a session, which defaults
        to "sealed"). There is no separate per-call "retention" parameter here — retention
        on "private" records is an owner-dashboard setting
        (``PATCH /v1/owner/agents/{id}/retention``), not something an agent's own signed
        request can set; this client is agent-authenticated only."""
        identity, agent_id = self._require_registered()
        aid = attestation_id or random_attestation_id()
        open_obj: AttestationOpen = {
            "v": 1,
            "type": "openglass.attestation_open",
            "attestationId": aid,
            "mode": mode,
            "purpose": purpose,
            "attestor": {"agentId": agent_id, "kid": identity.kid, "publicKey": base64url_encode(identity.public_key)},
            "createdAt": _iso(datetime.now(timezone.utc)),
        }
        open_signature = _sign_purpose("attestation_open", open_obj, identity)
        body: dict[str, Any] = {"open": open_obj, "openSignature": open_signature, "idleTimeoutSec": idle_timeout_sec}
        if visibility is not None:
            body["visibility"] = visibility
        result = self._signed("POST", "/v1/attestations", body)
        attestation = result["attestation"]
        if attestation.get("genesisHash"):
            self._head_by_attestation[aid] = _Head(seq=0, prev_hash=attestation["genesisHash"])
        return result

    def get_attestation(self, attestation_id: str) -> dict[str, Any]:
        return self._signed("GET", f"/v1/attestations/{attestation_id}")["attestation"]

    def send_attestation_event(
        self, attestation_id: str, payload: Any, content_type: str = "application/json", seq: int | None = None, prev_hash: str | None = None
    ) -> dict[str, Any]:
        """Appends one signed, hash-chained event — the one-party counterpart to
        ``send_message``. ``seq``/``prev_hash`` are tracked automatically from
        ``open_attestation``, same as sessions."""
        identity, agent_id = self._require_registered()
        tracked = self._head_by_attestation.get(attestation_id)
        resolved_seq = seq if seq is not None else (tracked.seq + 1 if tracked else None)
        resolved_prev_hash = prev_hash if prev_hash is not None else (tracked.prev_hash if tracked else None)
        if resolved_seq is None or resolved_prev_hash is None:
            raise RuntimeError(f"No tracked head for attestation {attestation_id} — call open_attestation first, or pass seq/prev_hash explicitly.")

        payload_hash = to_hex(sha256(canonicalize(payload).encode("utf-8")))
        envelope: MessageEnvelope = {
            "v": 1,
            "type": "openglass.message",
            "sessionId": attestation_id,
            "seq": resolved_seq,
            "prevHash": resolved_prev_hash,
            "sender": {"agentId": agent_id, "kid": identity.kid},
            "contentType": content_type,
            "payloadHash": payload_hash,
            "sentAt": _iso(datetime.now(timezone.utc)),
        }
        hash_bytes = sha256(bytes.fromhex(resolved_prev_hash) + canonicalize(envelope).encode("utf-8"))
        h = to_hex(hash_bytes)
        signature: Signature = {"alg": "Ed25519", "kid": identity.kid, "sig": base64url_encode(sign_ed25519(sig_input("message", hash_bytes), identity.private_key))}

        result = self._signed("POST", f"/v1/attestations/{attestation_id}/events", {"envelope": envelope, "hash": h, "signature": signature, "payload": payload})
        head = result["head"]
        self._head_by_attestation[attestation_id] = _Head(seq=head["seq"], prev_hash=head["hash"])
        return result

    def close_attestation(self, attestation_id: str) -> None:
        identity = self._require_identity()
        tracked = self._head_by_attestation.get(attestation_id)
        if tracked:
            head_seq = tracked.seq
            head_hash = None if tracked.seq == 0 else tracked.prev_hash
        else:
            attestation = self.get_attestation(attestation_id)
            head_seq = attestation["head"]["seq"]
            head_hash = attestation["head"]["hash"]
        statement: CloseStatement = {
            "v": 1,
            "type": "openglass.close",
            "sessionId": attestation_id,
            "headSeq": head_seq,
            "headHash": head_hash,
            "closedAt": _iso(datetime.now(timezone.utc)),
        }
        signature = _sign_purpose("close", statement, identity)
        self._signed("POST", f"/v1/attestations/{attestation_id}/close", {"statement": statement, "signature": signature})

    def wait_for_attestation_record(self, attestation_id: str, interval_s: float = 2.0, timeout_s: float | None = None) -> str:
        """Polls until the attestation is ``"closed"`` and a record has been issued;
        returns the ``recordId``."""

        def check() -> str | None:
            attestation = self.get_attestation(attestation_id)
            return attestation["recordId"] if attestation["status"] == "closed" and attestation.get("recordId") else None

        return _poll(check, interval_s, timeout_s)

    # ---- Sealed record ceremony (realignment R1/R4, docs/SPEC.md §13.2) ------------------

    def request_unseal(self, record_id: str) -> dict[str, Any]:
        """For a ``visibility: "sealed"`` record: requests the unseal ceremony, implicitly
        counting your own approval."""
        return self._signed("POST", f"/v1/records/{record_id}/unseal-request")

    def approve_unseal(self, record_id: str) -> dict[str, Any]:
        """Adds your own approval; the record fully unseals once every participant owner
        has called this."""
        return self._signed("POST", f"/v1/records/{record_id}/unseal-approve")

    def dispute(self, record_id: str) -> dict[str, Any]:
        """Force-unseals a sealed record immediately, bypassing the other owner's consent —
        for when you need to contest what's in it."""
        return self._signed("POST", f"/v1/records/{record_id}/dispute")

    # ---- guard() (realignment R7) ---------------------------------------------------------

    def guard(
        self,
        risk: str,
        counterparty_agent_id: str | None = None,
        min_risk_to_check: Literal["low", "medium", "high"] = "high",
        on_unverified_domain: GuardAction = "warn",
        on_new_counterparty: GuardAction = "allow",
    ) -> dict[str, Any]:
        """A pre-flight check for a tool call your own policy layer (e.g. ``openglass-policy``
        via ``core-js``/``core-py``) has already marked as worth a second look. ``guard()``
        doesn't run policy itself — pass in the risk level you've already computed. When
        that risk meets ``min_risk_to_check`` (default "high") and a
        ``counterparty_agent_id`` is given, it looks the counterparty up (``lookup()``) and
        decides "allow" / "warn" / "block" from your own ``on_unverified_domain`` /
        ``on_new_counterparty`` policy — there's no server-side "owner config" this reads;
        you configure it locally, since only you (the integration) knows what's appropriate
        for your own agent's risk tolerance. **Fails open**: if OpenGlass itself is
        unreachable, returns "allow" rather than block a real task on an infrastructure
        hiccup — this is advisory, not a hard gate. Returns
        ``{"action", "reason", "lookup": <LookupResult | None>}``."""
        rank = {"low": 0, "medium": 1, "high": 2}
        threshold = rank[min_risk_to_check]
        actual = rank.get(risk, rank["high"])  # unknown risk labels are treated as high, not skipped
        if actual < threshold:
            return {"action": "allow", "reason": f'risk "{risk}" is below the check threshold', "lookup": None}
        if not counterparty_agent_id:
            return {"action": "allow", "reason": "no counterparty to check", "lookup": None}

        try:
            info = self.lookup(agent_id=counterparty_agent_id)
        except Exception as err:  # noqa: BLE001 - deliberately broad: any failure here must fail open
            return {"action": "allow", "reason": f"OpenGlass unreachable, failing open: {err}", "lookup": None}

        if not info.get("registered"):
            return {"action": on_new_counterparty, "reason": "counterparty is not registered with OpenGlass at all", "lookup": info}
        if info.get("flags", {}).get("unverifiedDomain"):
            return {"action": on_unverified_domain, "reason": "counterparty's domain is not verified", "lookup": info}
        if info.get("flags", {}).get("newAgent"):
            return {"action": on_new_counterparty, "reason": "first time seeing this counterparty", "lookup": info}
        return {"action": "allow", "reason": "counterparty is registered, claimed, and domain-verified", "lookup": info}

    def fetch_trusted_keys(self) -> list[PlatformKey]:
        """``{apiUrl}/.well-known/openglass-keys.json`` — the platform's current and
        recently rotated ECDSA countersigning keys, fetched fresh over TLS (never trust
        ``bundle["platformKeys"]`` on its own; it's only a hint for which key to look up)."""
        return self._public("GET", "/.well-known/openglass-keys.json")["keys"]

    def verify_bundle(self, bundle: RecordBundle, trusted_keys: list[PlatformKey]) -> VerifyResult:
        """Offline, local verification (SPEC §7.6) — no network access beyond
        ``trusted_keys``, which you should fetch once and pin rather than re-fetching per
        call in anything security-sensitive."""
        return _verify_bundle(bundle, trusted_keys)

    def verify(self, bundle: RecordBundle) -> VerifyResult:
        """Convenience: fetches current trusted platform keys and verifies in one call.
        For repeated verification, prefer ``fetch_trusted_keys()`` once + ``verify_bundle()``
        per bundle."""
        return self.verify_bundle(bundle, self.fetch_trusted_keys())

    def verify_remote(self, bundle: RecordBundle) -> dict[str, Any]:
        """``POST /v1/verify`` — the server-side equivalent of ``verify()``, for when
        you'd rather not implement/trust local verification: anyone (not just registered
        agents) can call this with a bundle they got from someone else."""
        return self._public("POST", "/v1/verify", bundle)


def _sign_purpose(purpose: str, obj: Any, identity: AgentIdentity) -> Signature:
    digest = sha256(canonicalize(obj).encode("utf-8"))
    return {"alg": "Ed25519", "kid": identity.kid, "sig": base64url_encode(sign_ed25519(sig_input(purpose, digest), identity.private_key))}


def _iso(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _poll(check: Callable[[], Any], interval_s: float, timeout_s: float | None) -> Any:
    deadline = time.monotonic() + timeout_s if timeout_s is not None else None
    while True:
        result = check()
        if result is not None:
            return result
        if deadline is not None and time.monotonic() >= deadline:
            raise OpenGlassTimeoutError(f"Timed out after {timeout_s}s waiting for condition")
        time.sleep(interval_s)
