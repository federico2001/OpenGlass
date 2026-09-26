"""The default framework-native-event -> PolicyEvent mapping: OTel GenAI semantic
convention span attributes (https://opentelemetry.io/docs/specs/semconv/gen-ai/) pass
straight through as `attributes` (they're already flat, dotted keys — exactly what
`attr:<key>` addresses). If the span ended in error and no `error.type` attribute was set
directly, it's synthesized from the span's own status — see core-js's
`extractGenAiEvent.ts` for the same rationale.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from openglass_core.policy import PolicyEvent
from opentelemetry.trace import StatusCode

if TYPE_CHECKING:
    from opentelemetry.sdk.trace import ReadableSpan


def extract_gen_ai_event(span: "ReadableSpan") -> PolicyEvent:
    attributes: dict[str, object] = {}
    for key, value in (span.attributes or {}).items():
        if isinstance(value, (str, int, float, bool)):
            attributes[key] = value

    if span.status.status_code == StatusCode.ERROR and "error.type" not in attributes:
        attributes["error.type"] = span.status.description or "error"

    return {"attributes": attributes}
