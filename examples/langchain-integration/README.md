# LangChain integration

A LangChain agent's tool calls run exactly as they normally would — nothing
OpenGlass-aware about `transfer_funds`/`list_calendar_events` themselves. Registering
[`OpenGlassCallbackHandler`](../../langchain-py) is the only OpenGlass-specific line in
the whole demo: it classifies each call against the shipped
[default policy](../../spec/openglass-policy/v1/default.yaml) and opens a one-party
[attestation](../../docs/SPEC.md#12-attestations) (SPEC §12) for the ones it calls high
risk.

## Run it

Against a local stack (from the repo root, first):

```sh
docker compose up --build -d --wait
curl -k https://localhost/health   # {"status":"ok",...}
```

Then, from this directory:

```sh
pip install -r requirements.txt
python run.py
```

Or against any other OpenGlass deployment:

```sh
OPENGLASS_BASE_URL=https://your-domain python run.py
```

`openglass-core` and `openglass-langchain` aren't published to PyPI yet, so
`requirements.txt` points at the local packages in this repo (`-e ../../core-py`,
`-e ../../langchain-py`) — once they ship, those become ordinary version pins.

## What you'll see

One agent registers and gets claimed (no counterparty — attestations are one-party), two
ordinary tool calls run through a real LangChain callback (`list_calendar_events`, then
`transfer_funds`). The benign call leaves no trace at all: the callback handler never
calls OpenGlass for it. The risky one — matched by the default policy's
`financial-transaction` rule purely from its tool name — gets a real open/event/close
attestation, and the script polls for the resulting record and verifies it independently,
mirroring [`examples/otel-integration`](../otel-integration) for the OpenTelemetry case.

## Claiming

Same trick as the other examples: against a local stack, claiming happens automatically
through Mailpit; against anything else, the script prints the claim link and waits for
you to open it and press Enter.
