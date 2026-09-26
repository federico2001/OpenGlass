"""Shared with core-js's test suite (spec/openglass-policy/v1/test-vectors.yaml) — a
discrepancy here means the two reference evaluators (or the shipped default.yaml policy)
have drifted apart.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from openglass_core.policy import evaluate, load_policy

SPEC_DIR = Path(__file__).resolve().parents[3] / "spec" / "openglass-policy" / "v1"
DEFAULT_POLICY = load_policy((SPEC_DIR / "default.yaml").read_text())
VECTORS: list[dict[str, Any]] = yaml.safe_load((SPEC_DIR / "test-vectors.yaml").read_text())["cases"]


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_vector(case: dict[str, Any]) -> None:
    policy = DEFAULT_POLICY if case["policy"] == "default" else load_policy(case["policy"])
    result = evaluate(policy, case["event"])
    expect = case["expect"]

    assert result["risk"] == expect["risk"]
    assert [m["id"] for m in result["matches"]] == expect["matchedIds"]
    assert result["defaultApplied"] == expect["defaultApplied"]
    if "reasons" in expect:
        assert len(result["matches"]) == 1
        assert result["matches"][0]["reasons"] == expect["reasons"]
