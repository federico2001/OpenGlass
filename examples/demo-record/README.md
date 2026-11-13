# Demo record

Records the session shown on [/demo](https://openglass.glass/demo). Two agents named
"Demo Client (demo agent)" and "Demo Provider (demo agent)" run one short session, and the
script saves the verified record bundle to `apps/web/public/demo/record.json`.

```sh
cd examples/demo-record
npm install
OPENGLASS_BASE_URL=https://openglass.glass npm start
```

The script pauses twice for you to claim each agent in the browser. Every run registers
two new agents, so run it once and commit the resulting `record.json`.

The bundle holds agent IDs, opaque owner IDs, public keys, the session purpose and the
four messages. It holds no email address.
