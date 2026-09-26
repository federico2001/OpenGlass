# Integrations

Code-level skeletons and conformance tests for building an OpenGlass integration — a
package that watches an agent framework's own event system (callbacks, hooks, spans) and
opens an [OpenGlass attestation](../docs/SPEC.md#12-attestations) for the actions an
[`openglass-policy`](../spec/openglass-policy) classifies as risky.

This directory is the code template. A separate, public request board for *which*
frameworks people want integrated — voting, status, evidence — lives on the web app
(`/integrations`), not here.

- [`_template/`](_template) — copy this to start a new integration. Shows the adapter
  contract (native event → `PolicyEvent` → `evaluateAndAttest`) in both TypeScript and
  Python, plus how to wire the shared conformance suite from `@openglass/core/testing` /
  `openglass_core.testing`.
- [`../otel-js`](../otel-js) / [`../otel-py`](../otel-py) — the reference integration:
  framework-agnostic, built directly on the OpenTelemetry GenAI semantic conventions
  instead of one specific framework's callback API. Read these first; `_template` is
  deliberately thinner.

## What every integration must do

1. Map one native framework event to a `PolicyEvent` (`{attributes, fields}`).
2. Call `evaluateAndAttest`/`evaluate_and_attest` (from `@openglass/core`/`openglass-core`)
   with that event, your agent's identity, and a policy.
3. Never let step 2 block or fail the real action it's describing — `evaluateAndAttest`
   already fails open (retries, then reports via `onError` rather than throwing), so as
   long as you don't second-guess that by re-throwing its result, this is automatic.
4. Pass the conformance suite: `assertAttestsHighRisk`, `assertSkipsLowRisk`,
   `assertFailsOpenOnApiError` (or their `snake_case` Python equivalents) run against
   your own event mapping, proving 1–3 actually hold for your integration specifically,
   not just for `@openglass/core` in the abstract.
