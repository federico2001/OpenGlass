"""``verify(key, purpose, digest, sig)`` from SPEC §7.6: checks ``sig.sig`` over
``sigInput(purpose, digest)`` using ``key.alg``. Never raises — returns ``False`` on any
malformed input, so ``verify_bundle``'s pass can just record a failed check and continue.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.serialization import load_der_public_key

from ..types import Signature
from .ed25519 import base64url_decode
from .sig_input import sig_input

Alg = Literal["Ed25519", "ECDSA_P256_SHA256"]


@dataclass(frozen=True)
class VerifyingKey:
    alg: Alg
    kid: str
    public_key: bytes  # Ed25519: raw 32 bytes. ECDSA_P256_SHA256: SPKI DER bytes.


def verify_signature(key: VerifyingKey | None, purpose: str, digest: bytes, signature: Signature) -> bool:
    if key is None or signature["alg"] != key.alg or signature["kid"] != key.kid:
        return False
    try:
        message = sig_input(purpose, digest)
        sig_bytes = base64url_decode(signature["sig"])
        if key.alg == "Ed25519":
            Ed25519PublicKey.from_public_bytes(key.public_key).verify(sig_bytes, message)
            return True
        public_key = load_der_public_key(key.public_key)
        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            return False
        public_key.verify(sig_bytes, message, ec.ECDSA(SHA256()))
        return True
    except (InvalidSignature, ValueError):
        return False
