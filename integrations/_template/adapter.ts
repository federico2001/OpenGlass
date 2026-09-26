/**
 * Skeleton for a new OpenGlass integration (TypeScript). Copy this file into your own
 * package (see ../../otel-js for a complete, real example of this exact shape) and:
 *
 *   1. Replace `NativeEvent` with whatever your framework's hook/callback hands you.
 *   2. Fill in `extractEvent` to map it to a `PolicyEvent`.
 *   3. Register `handleNativeEvent` with your framework's own event system.
 *
 * Everything else — policy evaluation, retry, fail-open, the actual attestation
 * open/event/close calls — is `@openglass/core/attest`'s job, not yours.
 */
import { evaluateAndAttest, type AttestOptions, type AttestResult } from "@openglass/core/attest";
import type { Policy, PolicyEvent } from "@openglass/core/policy";
import type { AgentIdentity } from "openglass-sdk";

// TODO: replace with your framework's real event/callback payload shape.
export interface NativeEvent {
  toolName: string;
  args?: Record<string, unknown>;
}

/**
 * TODO: map one native event to a PolicyEvent. `attributes` should follow the
 * OpenTelemetry GenAI semantic conventions where your framework's data maps onto them
 * (gen_ai.tool.name, gen_ai.operation.name, ...) so the shipped default.yaml policy
 * works out of the box; put anything else in `fields`.
 */
export function extractEvent(nativeEvent: NativeEvent): PolicyEvent {
  return {
    attributes: { "gen_ai.tool.name": nativeEvent.toolName },
    fields: nativeEvent.args ?? {},
  };
}

export interface AdapterOptions extends AttestOptions {
  identity: AgentIdentity;
  policy: Policy;
}

/** Wire this into your framework's tool-call/action hook. */
export async function handleNativeEvent(nativeEvent: NativeEvent, opts: AdapterOptions): Promise<AttestResult> {
  return evaluateAndAttest(opts.identity, opts.policy, extractEvent(nativeEvent), opts);
}
