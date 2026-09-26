"""The Python port of core-js's `testing/conformance.ts` — see that file for the full
rationale. `ConformanceHarness` is a `Protocol` rather than an ABC since a plain callable
(or any object with a matching `process` method) should satisfy it without inheritance.
"""

from __future__ import annotations

from typing import Any, Protocol, TypedDict

from ..attest.types import AttestResult


class ConformanceHarness(Protocol):
    def process(self, native_event: Any) -> AttestResult: ...


class ConformanceFixtures(TypedDict):
    high_risk: Any
    low_risk: Any


def _fail(check: str, detail: str) -> None:
    raise AssertionError(f"openglass-core conformance: {check} — {detail}")


def assert_attests_high_risk(harness: ConformanceHarness, fixtures: ConformanceFixtures) -> None:
    result = harness.process(fixtures["high_risk"])
    if not result["attested"]:
        _fail("assert_attests_high_risk", f"expected an attestation, got {result!r}")


def assert_skips_low_risk(harness: ConformanceHarness, fixtures: ConformanceFixtures) -> None:
    result = harness.process(fixtures["low_risk"])
    if result["attested"]:
        _fail("assert_skips_low_risk", f"expected no attestation, got {result!r}")
    if result.get("reason") != "below_threshold":
        _fail("assert_skips_low_risk", f'expected reason "below_threshold", got {result.get("reason")!r}')


def assert_fails_open_on_api_error(harness: ConformanceHarness, fixtures: ConformanceFixtures) -> None:
    """`harness` must already be wired to a transport that always fails — see
    openglass-otel's own test suite for the pattern."""
    result = harness.process(fixtures["high_risk"])
    if result["attested"]:
        _fail("assert_fails_open_on_api_error", "expected the (simulated) API failure to prevent attestation")
    if result.get("reason") != "api_unreachable":
        _fail("assert_fails_open_on_api_error", f'expected reason "api_unreachable", got {result.get("reason")!r}')


def run_all_conformance_checks(harness: ConformanceHarness, fixtures: ConformanceFixtures) -> None:
    assert_attests_high_risk(harness, fixtures)
    assert_skips_low_risk(harness, fixtures)
