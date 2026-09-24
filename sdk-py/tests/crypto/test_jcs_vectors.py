"""RFC 8785 (JCS) conformance — ported from the same source vectors as
``packages/db/test/crypto/jcs.vectors.test.ts`` and ``sdk-js/test/crypto/jcs.vectors.test.ts``.
This port must keep passing the same cases the other two implementations do, or agent
signatures made with this SDK won't verify against a real OpenGlass server or other SDKs.
"""

from openglass.crypto.canonical_json import canonicalize

FRENCH_INPUT = {
    "peach": "This sorting order",
    "péché": "is wrong according to French",
    "pêche": "but canonicalization MUST",
    "sin": "ignore locale",
}
FRENCH_OUTPUT = (
    '{"peach":"This sorting order","péché":"is wrong according to French",'
    '"pêche":"but canonicalization MUST","sin":"ignore locale"}'
)


def test_matches_official_french_vector() -> None:
    assert canonicalize(FRENCH_INPUT) == FRENCH_OUTPUT


def test_produces_no_insignificant_whitespace() -> None:
    assert canonicalize({"a": 1, "b": [1, 2, {"c": 3}]}) == '{"a":1,"b":[1,2,{"c":3}]}'


def test_normalizes_negative_zero_to_zero() -> None:
    assert canonicalize({"n": -0.0}) == '{"n":0}'
    assert canonicalize({"n": 0}) == '{"n":0}'


def test_escapes_strings_like_json_stringify() -> None:
    tricky = "/€$\x0f\nA'B\"\\"
    assert canonicalize({"s": tricky}) == '{"s":"/€$\\u000f\\nA\'B\\"\\\\"}'


def test_rejects_non_finite_numbers() -> None:
    import math

    import pytest

    with pytest.raises(ValueError):
        canonicalize({"n": math.nan})
    with pytest.raises(ValueError):
        canonicalize({"n": math.inf})


def test_sorts_keys_regardless_of_insertion_order() -> None:
    assert canonicalize({"z": 1, "a": 2, "m": 3}) == canonicalize({"a": 2, "m": 3, "z": 1})


def test_booleans_and_null() -> None:
    assert canonicalize(True) == "true"
    assert canonicalize(False) == "false"
    assert canonicalize(None) == "null"
