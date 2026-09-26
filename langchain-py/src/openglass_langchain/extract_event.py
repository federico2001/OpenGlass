"""The default native-event -> PolicyEvent mapping: a LangChain tool call maps onto the
OpenTelemetry GenAI semantic conventions (gen_ai.operation.name, gen_ai.tool.name) so the
shipped default.yaml policy matches it the same way it matches a real OTel span (see
otel-py's extract_gen_ai_event.py) — the actual call arguments go in `fields`.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from openglass_core.policy import PolicyEvent


def extract_tool_event(tool_name: str, inputs: Optional[Dict[str, Any]], error: Optional[BaseException] = None) -> PolicyEvent:
    attributes: Dict[str, Any] = {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": tool_name}
    if error is not None:
        attributes["error.type"] = type(error).__name__
    return {"attributes": attributes, "fields": inputs or {}}
