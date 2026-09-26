import { SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { PolicyEvent } from "@openglass/core/policy";

/**
 * The default framework-native-event -> PolicyEvent mapping: OTel GenAI semantic
 * convention span attributes (https://opentelemetry.io/docs/specs/semconv/gen-ai/) pass
 * straight through as `attributes` (they're already flat, dotted keys — exactly what
 * `attr:<key>` addresses). If the span ended in error and no `error.type` attribute was
 * set directly (not every instrumentation sets one), it's synthesized from the span's
 * own status — this is what lets the default policy's `elevated-tool-error` rule fire on
 * spans instrumentation didn't tag explicitly.
 */
export function extractGenAiEvent(span: ReadableSpan): PolicyEvent {
  const attributes: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") attributes[key] = value;
  }
  if (span.status.code === SpanStatusCode.ERROR && attributes["error.type"] === undefined) {
    attributes["error.type"] = span.status.message || "error";
  }
  return { attributes };
}
