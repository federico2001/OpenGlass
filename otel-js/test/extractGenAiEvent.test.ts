import { SpanStatusCode, type SpanStatus } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { extractGenAiEvent } from "../src/extractGenAiEvent.js";

function fakeSpan(attributes: Record<string, unknown>, status: SpanStatus = { code: SpanStatusCode.UNSET }): ReadableSpan {
  return { attributes, status } as unknown as ReadableSpan;
}

describe("extractGenAiEvent", () => {
  it("passes string/number/boolean attributes straight through", () => {
    const event = extractGenAiEvent(fakeSpan({ "gen_ai.tool.name": "transfer_funds", "gen_ai.request.max_tokens": 100, "gen_ai.tool.arg.confirmed": true }));
    expect(event.attributes).toEqual({ "gen_ai.tool.name": "transfer_funds", "gen_ai.request.max_tokens": 100, "gen_ai.tool.arg.confirmed": true });
  });

  it("drops array and undefined attribute values", () => {
    const event = extractGenAiEvent(fakeSpan({ "gen_ai.tool.name": "x", "some.array": [1, 2, 3], "some.undefined": undefined }));
    expect(event.attributes).toEqual({ "gen_ai.tool.name": "x" });
  });

  it("leaves error.type alone when the span already set one", () => {
    const event = extractGenAiEvent(fakeSpan({ "error.type": "timeout" }, { code: SpanStatusCode.ERROR, message: "boom" }));
    expect(event.attributes?.["error.type"]).toBe("timeout");
  });

  it("synthesizes error.type from the span status when none was set", () => {
    const event = extractGenAiEvent(fakeSpan({}, { code: SpanStatusCode.ERROR, message: "boom" }));
    expect(event.attributes?.["error.type"]).toBe("boom");
  });

  it("does not add error.type for a non-error span", () => {
    const event = extractGenAiEvent(fakeSpan({}, { code: SpanStatusCode.OK }));
    expect(event.attributes?.["error.type"]).toBeUndefined();
  });
});
