"""Confirms spec/openglass-policy/v1/schema.json actually accepts the shipped
default.yaml and rejects the same malformed shapes load_policy() rejects — so the JSON
Schema, the artifact other languages/tools rely on, doesn't silently drift from what
this reference evaluator actually enforces.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import yaml

SPEC_DIR = Path(__file__).resolve().parents[3] / "spec" / "openglass-policy" / "v1"
SCHEMA = json.loads((SPEC_DIR / "schema.json").read_text())
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)


def test_accepts_the_shipped_default_yaml() -> None:
    doc = yaml.safe_load((SPEC_DIR / "default.yaml").read_text())
    errors = list(VALIDATOR.iter_errors(doc))
    assert errors == []


def test_rejects_an_unknown_top_level_field() -> None:
    doc = {"apiVersion": "openglass-policy/v1", "kind": "Policy", "metadata": {"name": "x"}, "rules": [], "extra": True}
    assert not VALIDATOR.is_valid(doc)


def test_rejects_a_bad_api_version() -> None:
    doc = {"apiVersion": "openglass-policy/v2", "kind": "Policy", "metadata": {"name": "x"}, "rules": []}
    assert not VALIDATOR.is_valid(doc)


def test_rejects_a_rule_with_an_invalid_risk_level() -> None:
    doc: dict[str, Any] = {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "x"},
        "rules": [{"id": "r1", "risk": "critical", "when": {"field": "field:a", "op": "exists"}}],
    }
    assert not VALIDATOR.is_valid(doc)


def test_rejects_a_leaf_condition_missing_op() -> None:
    doc: dict[str, Any] = {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "x"},
        "rules": [{"id": "r1", "risk": "high", "when": {"field": "field:a"}}],
    }
    assert not VALIDATOR.is_valid(doc)


def test_rejects_a_field_reference_without_a_prefix() -> None:
    doc: dict[str, Any] = {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "x"},
        "rules": [{"id": "r1", "risk": "high", "when": {"field": "amountUsd", "op": "gte", "value": 1}}],
    }
    assert not VALIDATOR.is_valid(doc)


def test_rejects_a_combinator_mixed_with_a_leaf_field_on_the_same_node() -> None:
    doc: dict[str, Any] = {
        "apiVersion": "openglass-policy/v1",
        "kind": "Policy",
        "metadata": {"name": "x"},
        "rules": [
            {
                "id": "r1",
                "risk": "high",
                "when": {"all": [{"field": "field:a", "op": "exists"}], "field": "field:b", "op": "exists"},
            }
        ],
    }
    assert not VALIDATOR.is_valid(doc)


def test_accepts_a_minimal_valid_policy_with_no_rules() -> None:
    doc = {"apiVersion": "openglass-policy/v1", "kind": "Policy", "metadata": {"name": "empty"}, "rules": []}
    assert VALIDATOR.is_valid(doc)
