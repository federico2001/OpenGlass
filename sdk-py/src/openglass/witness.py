from __future__ import annotations

from typing import Any, Callable

from .client import OpenGlassClient


def witness(send: Callable[..., Any], client: OpenGlassClient, session_id: str, content_type: str = "application/json") -> Callable[..., Any]:
    """Wraps an existing "send" function so every call is witnessed by OpenGlass first —
    same call signature, same return value, zero changes to your own send logic or its
    caller. The message is signed and posted to OpenGlass *before* ``send`` actually runs,
    so a witnessed record exists even if delivery itself then fails.

    ::

        send = witness(raw_send_to_counterparty, client=client, session_id=session.id)
        send({"text": "hello"})  # witnessed, then delivered exactly like raw_send_to_counterparty did
    """

    def wrapped(*args: Any, **kwargs: Any) -> Any:
        payload = args[0] if len(args) == 1 and not kwargs else {"args": args, "kwargs": kwargs}
        client.send_message(session_id, payload, content_type=content_type)
        return send(*args, **kwargs)

    return wrapped
