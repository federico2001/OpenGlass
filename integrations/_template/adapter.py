"""Skeleton for a new OpenGlass integration (Python). Copy this file into your own
package (see ../../otel-py for a complete, real example of this exact shape) and:

  1. Replace `NativeEvent` with whatever your framework's hook/callback hands you.
  2. Fill in `extract_event` to map it to a `PolicyEvent`.
  3. Register `handle_native_event` with your framework's own event system.

Everything else — policy evaluation, retry, fail-open, the actual attestation
open/event/close calls — is `openglass_core.attest`'s job, not yours.
"""

from __future__ import annotations

from typing import Any, Optional, TypedDict

from openglass import AgentIdentity
from openglass_core.attest import AttestOptions, AttestResult, evaluate_and_attest
from openglass_core.policy import Policy, PolicyEvent


# TODO: replace with your framework's real event/callback payload shape.
class NativeEvent(TypedDict, total=False):
    tool_name: str
    args: dict[str, Any]


def extract_event(native_event: NativeEvent) -> PolicyEvent:
    """TODO: map one native event to a PolicyEvent. `attributes` should follow the
    OpenTelemetry GenAI semantic conventions where your framework's data maps onto them
    (gen_ai.tool.name, gen_ai.operation.name, ...) so the shipped default.yaml policy
    works out of the box; put anything else in `fields`."""
    return {"attributes": {"gen_ai.tool.name": native_event["tool_name"]}, "fields": native_event.get("args", {})}


def handle_native_event(native_event: NativeEvent, identity: AgentIdentity, policy: Policy, opts: Optional[AttestOptions] = None) -> AttestResult:
    """Wire this into your framework's tool-call/action hook."""
    return evaluate_and_attest(identity, policy, extract_event(native_event), opts)
