<!--
Docs template for a new OpenGlass integration. Copy this file to your integration's own
README.md and fill in every {{PLACEHOLDER}}. Delete this comment block once you have.
-->

# openglass-{{FRAMEWORK_SLUG}}

An OpenGlass integration for [{{FRAMEWORK_NAME}}]({{FRAMEWORK_URL}}): classifies
{{FRAMEWORK_NAME}}'s {{EVENT_KIND, e.g. "tool calls" / "agent actions"}} against an
[`openglass-policy`](https://github.com/federico2001/OpenGlass/tree/main/spec/openglass-policy),
and opens an [OpenGlass attestation](https://github.com/federico2001/OpenGlass/blob/main/docs/SPEC.md#12-attestations)
for the ones it classifies as risky.

Built on `{{@openglass/core | openglass-core}}` — the policy evaluation, retry, and
fail-open behavior are that package's; this integration is just the
{{FRAMEWORK_NAME}}-specific event mapping and wiring on top.

## Install

```sh
{{npm install / pip install}} openglass-{{FRAMEWORK_SLUG}}
```

## Quickstart

```{{ts | python}}
{{10-15 line example: construct your identity/policy, wire the integration into
FRAMEWORK_NAME's own hook/callback registration, done.}}
```

## What gets attested

{{One paragraph + a short table or list: which native events map to which PolicyEvent
attributes/fields, and — using the shipped default.yaml as the example — which of those
would actually cross the risk threshold and get attested. Be concrete: name a real
{{FRAMEWORK_NAME}} tool/action and show the resulting attributes.}}

## Conformance

This integration's test suite passes the shared `@openglass/core/testing` /
`openglass_core.testing` conformance checks — see `test/conformance.test.ts` /
`tests/test_conformance.py`.

## Example

See [`examples/{{example-dir-name}}`](https://github.com/federico2001/OpenGlass/tree/main/examples/{{example-dir-name}})
for a runnable end-to-end demo.
