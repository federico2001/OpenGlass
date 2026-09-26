"""Filesystem-backed Ed25519 identity storage — the Python counterpart to
core-js's `attest/identity.ts`. Not a secrets vault; see that file's docstring for the
same caveat.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TypedDict

from openglass import AgentIdentity, base64url_decode, base64url_encode, generate_ed25519_keypair


class _StoredIdentity(TypedDict, total=False):
    agentId: str
    kid: str
    privateKey: str
    publicKey: str


def load_or_create_identity(path: str | Path) -> AgentIdentity:
    p = Path(path)
    if p.exists():
        return read_identity(p)
    keypair = generate_ed25519_keypair()
    identity = AgentIdentity(kid="new", private_key=keypair.private_key, public_key=keypair.public_key)
    persist_identity(p, identity)
    return identity


def read_identity(path: str | Path) -> AgentIdentity:
    stored: _StoredIdentity = json.loads(Path(path).read_text())
    return AgentIdentity(
        agent_id=stored.get("agentId"),
        kid=stored["kid"],
        private_key=base64url_decode(stored["privateKey"]),
        public_key=base64url_decode(stored["publicKey"]),
    )


def persist_identity(path: str | Path, identity: AgentIdentity) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    stored: _StoredIdentity = {
        "kid": identity.kid,
        "privateKey": base64url_encode(identity.private_key),
        "publicKey": base64url_encode(identity.public_key),
    }
    if identity.agent_id is not None:
        stored["agentId"] = identity.agent_id
    p.write_text(json.dumps(stored, indent=2))
    os.chmod(p, 0o600)
