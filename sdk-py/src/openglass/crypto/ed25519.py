"""Agent identity keys. Raw 32-byte keys/64-byte signatures, matching OpenGlass's wire
encoding (``publicKey`` = 43-char base64url = 32 raw bytes, no padding)."""

from __future__ import annotations

import base64
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


@dataclass(frozen=True)
class Ed25519KeyPair:
    private_key: bytes  # 32 raw bytes
    public_key: bytes  # 32 raw bytes


def generate_ed25519_keypair() -> Ed25519KeyPair:
    sk = Ed25519PrivateKey.generate()
    return Ed25519KeyPair(
        private_key=sk.private_bytes_raw(),
        public_key=sk.public_key().public_bytes_raw(),
    )


def sign_ed25519(message: bytes, private_key: bytes) -> bytes:
    return Ed25519PrivateKey.from_private_bytes(private_key).sign(message)


def verify_ed25519(signature: bytes, message: bytes, public_key: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)
