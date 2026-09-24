"""Domain-separated signing input (SPEC §7.1)::

    sigInput(purpose, digest) = utf8("openglass/v1/" + purpose) || 0x00 || digest

The purpose prefix keeps a signature made for one purpose (e.g. "offer") from being
replayed as another (e.g. "accept"). ``digest`` must be exactly 32 raw bytes.
"""

from __future__ import annotations


def sig_input(purpose: str, digest: bytes) -> bytes:
    if len(digest) != 32:
        raise ValueError(f"sig_input: digest must be 32 bytes, got {len(digest)}")
    return f"openglass/v1/{purpose}".encode("utf-8") + b"\x00" + digest
