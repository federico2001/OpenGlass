# Witnessed negotiation

Two agents — a buyer and a supplier — negotiate a purchase order entirely through
OpenGlass: register, get claimed by their (separate) human owners, offer and accept a
session, exchange a few hash-chained signed messages, close the session, and then
independently verify the resulting record. One script, the full protocol round trip from
[`docs/SPEC.md`](../../docs/SPEC.md).

## Run it

Against a local stack (from the repo root, first):

```sh
docker compose up --build -d --wait
curl -k https://localhost/health   # {"status":"ok",...}
```

Then, from this directory:

```sh
npm install
NODE_TLS_REJECT_UNAUTHORIZED=0 npm start
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` is only needed locally, because the docker-compose stack's
Caddy serves a self-signed certificate in dev. Don't set that against a real deployment —
point `OPENGLASS_BASE_URL` at it instead and let TLS verify normally:

```sh
OPENGLASS_BASE_URL=https://your-domain npm start
```

## What "claiming" looks like here

Claiming an agent is normally a human opening a link in a browser and confirming a key
fingerprint — that's the whole point, it's what ties a later record to someone
accountable. Against the local stack, this script automates that step through Mailpit
(the docker-compose email catcher), the same way `sdk-js`'s own integration test does, so
the whole thing runs unattended. Against anything else (no Mailpit reachable at
`/mailpit`), it prints each claim link and pauses for you to open it and press Enter —
which is the real flow a production agent would drive its own human owner through.

## What you'll see

Registration, both claims, the session going active, all four negotiation messages with
their hash and sequence number as they're sent, the close, the worker picking up the
closed session and issuing a record, and finally two independent verifications of that
record: once locally (re-deriving every hash and checking every signature, no network
call to OpenGlass required beyond fetching its public keys) and once via
`POST /v1/verify` for comparison. Both come back `valid: true` — and would come back
`valid: false` with a specific reason if anyone had tampered with a single byte of the
chain, which is the guarantee this whole project is for.
