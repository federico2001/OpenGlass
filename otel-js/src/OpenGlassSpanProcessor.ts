import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { evaluateAndAttest, type AttestOptions } from "@openglass/core/attest";
import type { AgentIdentity } from "openglass-sdk";
import type { Policy, PolicyEvent } from "@openglass/core/policy";
import { extractGenAiEvent } from "./extractGenAiEvent.js";

export interface OpenGlassSpanProcessorOptions extends AttestOptions {
  identity: AgentIdentity;
  policy: Policy;
  /** How often the queued spans are evaluated and (if risky) attested, in ms. Default
   * 5000 — matching the spirit of OTel's own BatchSpanProcessor default. */
  scheduledDelayMs?: number;
  /** Override to map a span to a `PolicyEvent` differently — e.g. to add `fields` your
   * own instrumentation sets that aren't part of the OTel GenAI semantic conventions.
   * Default: `extractGenAiEvent` (OTel attributes only, `fields` empty). */
  extractEvent?: (span: ReadableSpan) => PolicyEvent;
}

/**
 * Reads OpenTelemetry GenAI spans (https://opentelemetry.io/docs/specs/semconv/gen-ai/)
 * as they end, classifies each against an openglass-policy, and opens an OpenGlass
 * attestation for the risky ones (SPEC §12) — batched on `scheduledDelayMs`, or
 * immediately via `forceFlush()`.
 *
 * `onEnd` only enqueues (SpanProcessor.onEnd is synchronous by contract); the actual
 * evaluation + attestation calls happen in the batch flush, so a slow or unreachable
 * OpenGlass API never blocks span processing itself — on top of `evaluateAndAttest`'s
 * own per-call fail-open behavior.
 */
export class OpenGlassSpanProcessor implements SpanProcessor {
  private queue: ReadableSpan[] = [];
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: OpenGlassSpanProcessorOptions) {
    this.timer = setInterval(() => {
      this.flushQueue().catch((err: unknown) => (this.opts.onError ?? console.error)(err));
    }, opts.scheduledDelayMs ?? 5000);
    this.timer.unref?.();
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    this.queue.push(span);
  }

  async forceFlush(): Promise<void> {
    await this.flushQueue();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.flushQueue();
  }

  private async flushQueue(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const extract = this.opts.extractEvent ?? extractGenAiEvent;
    await Promise.all(batch.map((span) => evaluateAndAttest(this.opts.identity, this.opts.policy, extract(span), this.opts)));
  }
}
