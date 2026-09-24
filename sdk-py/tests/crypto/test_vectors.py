"""Cross-implementation drift check, sharing ``sdk-js/fixtures/vectors.json`` — generated
by ``sdk-js/scripts/generate-vectors.ts`` using ``packages/db``'s real, production crypto
code, not a hand-typed fixture. If this SDK's independently ported ``canonicalize``/
``sha256``/``verify_bundle`` don't reproduce the exact same output the server produced,
agent signatures made with this SDK will fail to verify against a real server — or against
sdk-js, since both SDKs check themselves against this one shared file.

Re-run ``pnpm generate:vectors`` (in sdk-js/) after any protocol or crypto change; both
SDKs' test suites pick up the regenerated file automatically.
"""

import json
from pathlib import Path

from openglass.crypto.canonical_json import canonicalize
from openglass.crypto.hash import sha256, to_hex
from openglass.crypto.verify_bundle import verify_bundle

VECTORS_PATH = Path(__file__).resolve().parents[3] / "sdk-js" / "fixtures" / "vectors.json"


def _load_vectors() -> dict:
    return json.loads(VECTORS_PATH.read_text())


def test_canonicalize_matches_server_output_byte_for_byte() -> None:
    vectors = _load_vectors()
    for v in vectors["canonicalization"]:
        got = canonicalize(v["input"])
        assert got == v["expected"], f"input={v['input']!r} expected={v['expected']!r} got={got!r}"
        if "expectedHex" in v:
            assert to_hex(sha256(canonicalize(v["input"]).encode("utf-8"))) == v["expectedHex"]


def test_verify_bundle_accepts_a_genuinely_signed_bundle() -> None:
    vectors = _load_vectors()
    bundle = vectors["validBundle"]
    result = verify_bundle(bundle, bundle["platformKeys"])
    assert result.errors == []
    assert result.valid is True


def test_verify_bundle_rejects_a_tampered_bundle() -> None:
    vectors = _load_vectors()
    bundle = vectors["tamperedBundle"]
    result = verify_bundle(bundle, bundle["platformKeys"])
    assert result.valid is False
    assert len(result.errors) > 0
    codes = {e.code for e in result.errors}
    # Canary for "did we actually re-derive the genesis hash, or just trust the bundle's
    # own claims" — both must fail once the offer is tampered with after signing.
    assert "offer_hash" in codes
    assert "genesis_hash" in codes
