"""``H(bytes) = sha256(bytes)`` (SPEC §7.1)."""

from __future__ import annotations

import hashlib
import re

_HEX_RE = re.compile(r"^[0-9a-f]+$")


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def to_hex(data: bytes) -> str:
    return data.hex()


def hex_to_bytes(value: str) -> bytes:
    if not _HEX_RE.match(value) or len(value) % 2 != 0:
        raise ValueError(f"hex_to_bytes: not a valid lowercase hex string: {value!r}")
    return bytes.fromhex(value)
