"""The Python port of core-js's `OpenGlassSpanProcessor.ts` — see that file's docstring
for the full design rationale (batching, fail-open, why `on_end` only enqueues).
"""

from __future__ import annotations

import threading
from typing import Any, Callable, List, Optional

from openglass_core.attest import AttestOptions, evaluate_and_attest
from openglass_core.policy import Policy
from opentelemetry.context import Context
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from openglass import AgentIdentity

from .extract_gen_ai_event import extract_gen_ai_event


class OpenGlassSpanProcessor(SpanProcessor):
    def __init__(
        self,
        identity: AgentIdentity,
        policy: Policy,
        scheduled_delay_millis: float = 5000,
        extract_event: Optional[Callable[[ReadableSpan], Any]] = None,
        attest_options: Optional[AttestOptions] = None,
    ) -> None:
        self._identity = identity
        self._policy = policy
        self._extract_event = extract_event or extract_gen_ai_event
        self._attest_options: AttestOptions = attest_options or {}
        self._queue: List[ReadableSpan] = []
        self._lock = threading.Lock()
        self._timer = threading.Timer(scheduled_delay_millis / 1000, self._on_timer)
        self._timer.daemon = True
        self._timer.start()
        self._scheduled_delay_millis = scheduled_delay_millis

    def _on_timer(self) -> None:
        try:
            self._flush_queue()
        finally:
            self._timer = threading.Timer(self._scheduled_delay_millis / 1000, self._on_timer)
            self._timer.daemon = True
            self._timer.start()

    def on_start(self, span: Span, parent_context: Optional[Context] = None) -> None:
        pass

    def on_end(self, span: ReadableSpan) -> None:
        with self._lock:
            self._queue.append(span)

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        self._flush_queue()
        return True

    def shutdown(self) -> None:
        self._timer.cancel()
        self._flush_queue()

    def _flush_queue(self) -> None:
        with self._lock:
            batch, self._queue = self._queue, []
        for span in batch:
            evaluate_and_attest(self._identity, self._policy, self._extract_event(span), self._attest_options)
