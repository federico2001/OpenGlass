# openglass-langchain

An OpenGlass integration for [LangChain](https://www.langchain.com/): classifies tool
calls against an [`openglass-policy`](../spec/openglass-policy), and opens an
[OpenGlass attestation](../docs/SPEC.md#12-attestations) for the ones it classifies as
risky.

Built on [`openglass-core`](../core-py) — the policy evaluation, retry, and fail-open
behavior are that package's; this integration is just a LangChain
`BaseCallbackHandler` mapping tool-call events to it.

## Install

```sh
pip install openglass-langchain
```

## Quickstart

```python
from pathlib import Path
from langchain_core.tools import tool
from openglass_core.attest import load_or_create_identity
from openglass_core.policy import load_policy
from openglass_langchain import OpenGlassCallbackHandler

identity = load_or_create_identity("openglass-identity.json")
policy = load_policy(Path("default.yaml").read_text())
handler = OpenGlassCallbackHandler(identity, policy)

@tool
def transfer_funds(amount: float, recipient: str) -> str:
    """Transfer funds to a recipient."""
    return f"transferred {amount} to {recipient}"

# Register the handler on any tool call, or pass it in an agent's config.callbacks —
# either way, every on_tool_start/on_tool_end (or on_tool_error) LangChain fires for you
# gets classified and, if risky, witnessed.
transfer_funds.invoke({"amount": 500, "recipient": "acme-vendor"}, config={"callbacks": [handler]})
```

## What gets attested

Every tool call becomes a `PolicyEvent` with `attributes: {"gen_ai.operation.name":
"execute_tool", "gen_ai.tool.name": <tool name>}` (matching the OpenTelemetry GenAI
semantic conventions the shipped default policy already matches on) and `fields` set to
the tool's actual call arguments. A tool call that raises gets `error.type` set to the
exception's class name, same as `openglass-otel`'s span-status synthesis — so the default
policy's `elevated-tool-error` rule still fires for a failed high-risk-adjacent call.

Concretely, against the shipped `default.yaml`: a tool named `transfer_funds` matches
`financial-transaction` (tool-name regex) and gets attested; a tool named
`list_calendar_events` matches nothing and is never called out to OpenGlass at all.

## Conformance

This package's own test suite (`tests/test_conformance.py`) runs the shared
`openglass_core.testing` conformance checks against its real callback-handling pipeline —
the same checks any other integration should run against its own event mapping. See
[`integrations/_template`](../integrations/_template).

## Known limitation

`OpenGlassCallbackHandler` implements the synchronous `BaseCallbackHandler` — it works
with `.invoke()`/synchronous chains and agents. An async LangChain pipeline
(`.ainvoke()`, `AsyncCallbackHandler`) needs its own async override calling
`evaluate_and_attest` from a thread executor (`openglass_core.attest` is itself
synchronous, matching `openglass-sdk`'s own client) — not yet implemented here.

## Example

See [`examples/langchain-integration`](../examples/langchain-integration) for a runnable
end-to-end demo.

## Develop

```sh
pip install -e ".[dev]"
mypy src
pytest -v
```
