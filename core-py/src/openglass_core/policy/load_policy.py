from __future__ import annotations

import re
from typing import Any, Union, cast

import yaml

from .types import Policy

_KEBAB = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
_FIELD_REF = re.compile(r"^(attr|field):.+$")
_RISK_LEVELS = {"low", "medium", "high"}
_OPS = {"equals", "not_equals", "in", "not_in", "matches", "contains", "gt", "gte", "lt", "lte", "exists", "not_exists"}


def load_policy(source: Union[str, dict[str, Any]]) -> Policy:
    """Parses (if given a string) and validates an openglass-policy v1 document. Raises
    ValueError with the first structural problem found (unknown fields, bad enum values,
    duplicate rule ids, a condition that's neither a leaf nor a combinator)."""
    raw = yaml.safe_load(source) if isinstance(source, str) else source
    _validate_policy(raw)
    return cast(Policy, raw)


def _validate_policy(doc: Any) -> None:
    if not isinstance(doc, dict):
        raise ValueError("policy document must be a mapping")
    if doc.get("apiVersion") != "openglass-policy/v1":
        raise ValueError('apiVersion must be "openglass-policy/v1"')
    if doc.get("kind") != "Policy":
        raise ValueError('kind must be "Policy"')
    unknown = set(doc.keys()) - {"apiVersion", "kind", "metadata", "defaultRisk", "rules"}
    if unknown:
        raise ValueError(f"unknown top-level field(s): {sorted(unknown)}")

    metadata = doc.get("metadata")
    if not isinstance(metadata, dict) or not _KEBAB.match(str(metadata.get("name", ""))):
        raise ValueError("metadata.name must be a non-empty kebab-case string")
    unknown_meta = set(metadata.keys()) - {"name", "description"}
    if unknown_meta:
        raise ValueError(f"unknown metadata field(s): {sorted(unknown_meta)}")

    default_risk = doc.get("defaultRisk")
    if default_risk is not None and default_risk not in _RISK_LEVELS:
        raise ValueError(f"defaultRisk must be one of {sorted(_RISK_LEVELS)}")

    rules = doc.get("rules")
    if not isinstance(rules, list):
        raise ValueError("rules must be a list")
    seen_ids: set[str] = set()
    for rule in rules:
        _validate_rule(rule, seen_ids)


def _validate_rule(rule: Any, seen_ids: set[str]) -> None:
    if not isinstance(rule, dict):
        raise ValueError("each rule must be a mapping")
    rule_id = rule.get("id")
    if not isinstance(rule_id, str) or not _KEBAB.match(rule_id):
        raise ValueError(f"rule id must be kebab-case: {rule_id!r}")
    if rule_id in seen_ids:
        raise ValueError(f'duplicate rule id "{rule_id}"')
    seen_ids.add(rule_id)

    if rule.get("risk") not in _RISK_LEVELS:
        raise ValueError(f'rule "{rule_id}": risk must be one of {sorted(_RISK_LEVELS)}')
    unknown = set(rule.keys()) - {"id", "risk", "description", "when", "reasons"}
    if unknown:
        raise ValueError(f'rule "{rule_id}": unknown field(s) {sorted(unknown)}')
    if "when" not in rule:
        raise ValueError(f'rule "{rule_id}": missing "when"')
    _validate_condition(rule["when"], rule_id)

    reasons = rule.get("reasons")
    if reasons is not None and not (isinstance(reasons, list) and all(isinstance(r, str) for r in reasons)):
        raise ValueError(f'rule "{rule_id}": reasons must be a list of strings')


def _validate_condition(cond: Any, rule_id: str) -> None:
    if not isinstance(cond, dict):
        raise ValueError(f'rule "{rule_id}": condition must be a mapping')
    keys = set(cond.keys())

    if keys == {"all"} or keys == {"any"}:
        combinator = "all" if "all" in cond else "any"
        items = cond[combinator]
        if not isinstance(items, list) or len(items) < 1:
            raise ValueError(f'rule "{rule_id}": "{combinator}" must be a non-empty list')
        for item in items:
            _validate_condition(item, rule_id)
        return

    if keys == {"not"}:
        _validate_condition(cond["not"], rule_id)
        return

    if keys == {"field", "op"} or keys == {"field", "op", "value"}:
        field = cond["field"]
        if not isinstance(field, str) or not _FIELD_REF.match(field):
            raise ValueError(f'rule "{rule_id}": field must start with "attr:" or "field:", got {field!r}')
        if cond["op"] not in _OPS:
            raise ValueError(f'rule "{rule_id}": unknown op {cond["op"]!r}')
        return

    raise ValueError(f'rule "{rule_id}": malformed condition {cond!r}')
