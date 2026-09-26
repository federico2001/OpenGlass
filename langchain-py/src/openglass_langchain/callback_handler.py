from __future__ import annotations

from typing import Any, Callable, Dict, Optional
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from openglass import AgentIdentity
from openglass_core.attest import AttestOptions, evaluate_and_attest
from openglass_core.policy import Policy, PolicyEvent

from .extract_event import extract_tool_event


class OpenGlassCallbackHandler(BaseCallbackHandler):
    """Classifies every LangChain tool call against `policy` and, if risky, opens an
    OpenGlass attestation for it (SPEC §12) — synchronous, matching `openglass-core`'s
    own client (see README's "Known limitation" for async pipelines).

    `on_tool_start`/`on_tool_end` fire in pairs correlated by `run_id`; the actual
    classification + attestation happens in `on_tool_end`/`on_tool_error`, once the call
    arguments are known, using the extractor supplied (default: `extract_tool_event`).
    """

    def __init__(
        self,
        identity: AgentIdentity,
        policy: Policy,
        attest_options: Optional[AttestOptions] = None,
        extract_event: Optional[Callable[[str, Optional[Dict[str, Any]], Optional[BaseException]], PolicyEvent]] = None,
    ) -> None:
        self._identity = identity
        self._policy = policy
        self._attest_options = attest_options or {}
        self._extract_event = extract_event or extract_tool_event
        self._pending: Dict[UUID, tuple[str, Optional[Dict[str, Any]]]] = {}

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        tags: Optional[list[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        inputs: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        name = serialized.get("name", "unknown_tool")
        self._pending[run_id] = (name, inputs if inputs is not None else {"input": input_str})

    def on_tool_end(self, output: Any, *, run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        name, inputs = self._pending.pop(run_id, ("unknown_tool", None))
        event = self._extract_event(name, inputs, None)
        evaluate_and_attest(self._identity, self._policy, event, self._attest_options)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        name, inputs = self._pending.pop(run_id, ("unknown_tool", None))
        event = self._extract_event(name, inputs, error)
        evaluate_and_attest(self._identity, self._policy, event, self._attest_options)
