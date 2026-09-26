"""openglass-policy v1 (spec/openglass-policy/README.md, schema.json). Plain TypedDicts,
matching sdk-py's own convention (no pydantic) — these are what you load from YAML and
pass to evaluate(), not a validation-library model.
"""

from __future__ import annotations

from typing import Any, List, Literal, TypedDict, Union

RiskLevel = Literal["low", "medium", "high"]

_RISK_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2}


def higher_risk(a: RiskLevel, b: RiskLevel) -> RiskLevel:
    return a if _RISK_ORDER[a] >= _RISK_ORDER[b] else b


ConditionOp = Literal[
    "equals", "not_equals", "in", "not_in", "matches", "contains", "gt", "gte", "lt", "lte", "exists", "not_exists"
]


class _LeafConditionRequired(TypedDict):
    field: str
    op: ConditionOp


class LeafCondition(_LeafConditionRequired, total=False):
    """`value` is the one optional key (Python 3.10 has no `NotRequired`, hence the
    required/optional split) — absent for the exists/not_exists ops, required otherwise."""

    value: Any


class AllCondition(TypedDict):
    all: List["Condition"]


class AnyCondition(TypedDict):
    any: List["Condition"]


# TypedDict class syntax can't declare a field literally named "not" (reserved word),
# hence the functional form.
NotCondition = TypedDict("NotCondition", {"not": "Condition"})

Condition = Union[LeafCondition, AllCondition, AnyCondition, NotCondition]


class _PolicyRuleRequired(TypedDict):
    id: str
    risk: RiskLevel
    when: Condition


class PolicyRule(_PolicyRuleRequired, total=False):
    description: str
    reasons: List[str]


class _PolicyMetadataRequired(TypedDict):
    name: str


class PolicyMetadata(_PolicyMetadataRequired, total=False):
    description: str


class _PolicyRequired(TypedDict):
    apiVersion: Literal["openglass-policy/v1"]
    kind: Literal["Policy"]
    metadata: PolicyMetadata
    rules: List[PolicyRule]


class Policy(_PolicyRequired, total=False):
    defaultRisk: RiskLevel


class PolicyEvent(TypedDict, total=False):
    """`attributes`: OpenTelemetry GenAI span attributes, keyed by their flat (dotted)
    name exactly as OTel emits them, e.g. "gen_ai.tool.name". `fields`: arbitrary plain
    fields the caller supplies alongside or instead of attributes."""

    attributes: dict[str, Any]
    fields: dict[str, Any]


class _RuleMatchRequired(TypedDict):
    id: str
    risk: RiskLevel
    reasons: List[str]


class RuleMatch(_RuleMatchRequired, total=False):
    description: str


class PolicyResult(TypedDict):
    risk: RiskLevel
    matches: List[RuleMatch]
    defaultApplied: bool
