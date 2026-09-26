from __future__ import annotations

import pytest

from openglass_core.policy import load_policy


def test_parses_a_yaml_string() -> None:
    policy = load_policy(
        """
apiVersion: openglass-policy/v1
kind: Policy
metadata: { name: test }
rules:
  - id: r1
    risk: high
    when: { field: "field:action", op: equals, value: delete_user }
"""
    )
    assert policy["metadata"]["name"] == "test"
    assert len(policy["rules"]) == 1


def test_accepts_a_plain_dict_without_parsing() -> None:
    policy = load_policy({"apiVersion": "openglass-policy/v1", "kind": "Policy", "metadata": {"name": "test"}, "rules": []})
    assert policy["rules"] == []


def test_rejects_duplicate_rule_ids() -> None:
    with pytest.raises(ValueError, match="duplicate rule id"):
        load_policy(
            {
                "apiVersion": "openglass-policy/v1",
                "kind": "Policy",
                "metadata": {"name": "test"},
                "rules": [
                    {"id": "dup", "risk": "high", "when": {"field": "field:a", "op": "exists"}},
                    {"id": "dup", "risk": "low", "when": {"field": "field:b", "op": "exists"}},
                ],
            }
        )


def test_rejects_a_field_reference_without_a_prefix() -> None:
    with pytest.raises(ValueError):
        load_policy(
            {
                "apiVersion": "openglass-policy/v1",
                "kind": "Policy",
                "metadata": {"name": "test"},
                "rules": [{"id": "r1", "risk": "high", "when": {"field": "amountUsd", "op": "gte", "value": 1}}],
            }
        )


def test_rejects_an_unknown_top_level_field() -> None:
    with pytest.raises(ValueError):
        load_policy(
            {
                "apiVersion": "openglass-policy/v1",
                "kind": "Policy",
                "metadata": {"name": "test"},
                "rules": [],
                "extra": True,
            }
        )
