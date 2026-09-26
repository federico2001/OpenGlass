from __future__ import annotations

from types import SimpleNamespace

from openglass_otel.extract_gen_ai_event import extract_gen_ai_event
from opentelemetry.trace import Status, StatusCode


def fake_span(attributes: dict[str, object], status: Status = Status(StatusCode.UNSET)) -> SimpleNamespace:
    return SimpleNamespace(attributes=attributes, status=status)


def test_passes_string_number_boolean_attributes_straight_through() -> None:
    event = extract_gen_ai_event(fake_span({"gen_ai.tool.name": "transfer_funds", "gen_ai.request.max_tokens": 100, "gen_ai.tool.arg.confirmed": True}))  # type: ignore[arg-type]
    assert event["attributes"] == {"gen_ai.tool.name": "transfer_funds", "gen_ai.request.max_tokens": 100, "gen_ai.tool.arg.confirmed": True}


def test_drops_non_scalar_attribute_values() -> None:
    event = extract_gen_ai_event(fake_span({"gen_ai.tool.name": "x", "some.tuple": (1, 2, 3)}))  # type: ignore[arg-type]
    assert event["attributes"] == {"gen_ai.tool.name": "x"}


def test_leaves_error_type_alone_when_the_span_already_set_one() -> None:
    event = extract_gen_ai_event(fake_span({"error.type": "timeout"}, Status(StatusCode.ERROR, "boom")))  # type: ignore[arg-type]
    assert event["attributes"]["error.type"] == "timeout"


def test_synthesizes_error_type_from_the_span_status_when_none_was_set() -> None:
    event = extract_gen_ai_event(fake_span({}, Status(StatusCode.ERROR, "boom")))  # type: ignore[arg-type]
    assert event["attributes"]["error.type"] == "boom"


def test_does_not_add_error_type_for_a_non_error_span() -> None:
    event = extract_gen_ai_event(fake_span({}, Status(StatusCode.OK)))  # type: ignore[arg-type]
    assert "error.type" not in event["attributes"]
