from __future__ import annotations

import re
from typing import Any, List, cast

from .types import Condition, LeafCondition, Policy, PolicyEvent, PolicyResult, RuleMatch, higher_risk


def _resolve_field(field: str, event: PolicyEvent) -> Any:
    if field.startswith("attr:"):
        return (event.get("attributes") or {}).get(field[len("attr:") :])
    if field.startswith("field:"):
        cur: Any = event.get("fields")
        for segment in field[len("field:") :].split("."):
            if not isinstance(cur, dict):
                return None
            cur = cur.get(segment)
        return cur
    # Unreachable once a Condition has passed load_policy's field-ref validation.
    raise ValueError(f"Unrecognized field reference: {field}")


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _match_leaf(cond: LeafCondition, event: PolicyEvent) -> bool:
    actual = _resolve_field(cond["field"], event)
    op = cond["op"]
    value = cond.get("value")
    if op == "exists":
        return actual is not None
    if op == "not_exists":
        return actual is None
    if op == "equals":
        return bool(actual == value)
    if op == "not_equals":
        return bool(actual != value)
    if op == "in":
        return isinstance(value, list) and actual in value
    if op == "not_in":
        return isinstance(value, list) and actual not in value
    if op == "matches":
        if not isinstance(actual, str) or not isinstance(value, str):
            return False
        ci = value.startswith("(?i)")
        pattern = value[4:] if ci else value
        return re.search(pattern, actual, re.IGNORECASE if ci else 0) is not None
    if op == "contains":
        if isinstance(actual, list):
            return value in actual
        if isinstance(actual, str) and isinstance(value, str):
            return value in actual
        return False
    if op in ("gt", "gte", "lt", "lte"):
        if not _is_number(actual) or not _is_number(value):
            return False
        if op == "gt":
            return cast(float, actual) > cast(float, value)
        if op == "gte":
            return cast(float, actual) >= cast(float, value)
        if op == "lt":
            return cast(float, actual) < cast(float, value)
        return cast(float, actual) <= cast(float, value)
    raise ValueError(f"Unknown operator: {op}")


def _match_condition(cond: Condition, event: PolicyEvent) -> bool:
    d = cast(dict[str, Any], cond)
    if "all" in d:
        return all(_match_condition(c, event) for c in d["all"])
    if "any" in d:
        return any(_match_condition(c, event) for c in d["any"])
    if "not" in d:
        return not _match_condition(d["not"], event)
    return _match_leaf(cast(LeafCondition, cond), event)


def evaluate(policy: Policy, event: PolicyEvent) -> PolicyResult:
    """Evaluates every rule against `event` and returns the highest risk among matches
    (spec/openglass-policy/README.md#evaluation), or `policy["defaultRisk"]` (default
    "low") if nothing matched."""
    matches: List[RuleMatch] = []
    for rule in policy["rules"]:
        if _match_condition(rule["when"], event):
            match: RuleMatch = {"id": rule["id"], "risk": rule["risk"], "reasons": rule.get("reasons", [])}
            if "description" in rule:
                match["description"] = rule["description"]
            matches.append(match)

    if not matches:
        return {"risk": policy.get("defaultRisk", "low"), "matches": [], "defaultApplied": True}
    risk = matches[0]["risk"]
    for m in matches[1:]:
        risk = higher_risk(risk, m["risk"])
    return {"risk": risk, "matches": matches, "defaultApplied": False}
