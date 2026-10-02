import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describePayload, PayloadView } from "../components/PayloadView";
import { VerifyResultView } from "../components/VerifyResultView";

const hash = "a".repeat(64);
const msg = (payload?: unknown) => (payload === undefined ? { envelope: { payloadHash: hash } } : { payload, envelope: { payloadHash: hash } });

describe("describePayload / PayloadView", () => {
  it("shows a { text } payload as plain text", () => {
    expect(describePayload(msg({ text: "hello" }))).toEqual({ kind: "text", text: "hello" });
    expect(renderToStaticMarkup(<PayloadView message={msg({ text: "hello" })} />)).toContain("hello");
  });

  it("shows any other relay payload as formatted JSON, never as missing", () => {
    const payload = { proposal: { deliveryDate: "2026-10-01" }, text: "and a note" };
    const d = describePayload(msg(payload));
    expect(d).toEqual({ kind: "json", json: JSON.stringify(payload, null, 2) });
    const html = renderToStaticMarkup(<PayloadView message={msg(payload)} />);
    expect(html).toContain("deliveryDate");
    expect(html).not.toContain("Notary mode");
  });

  it("handles strings, arrays, numbers and null as content", () => {
    expect(describePayload(msg("plain"))).toEqual({ kind: "text", text: "plain" });
    expect(describePayload(msg([1, 2])).kind).toBe("json");
    expect(describePayload(msg(0)).kind).toBe("json");
    expect(describePayload(msg(null)).kind).toBe("json");
  });

  it("only says the content isn't held when there is no payload at all (Notary mode)", () => {
    expect(describePayload(msg())).toEqual({ kind: "hash-only", payloadHash: hash });
    const html = renderToStaticMarkup(<PayloadView message={msg()} />);
    expect(html).toContain("Notary mode");
    expect(html).toContain(hash);
  });
});

describe("VerifyResultView", () => {
  it("renders structured verification errors (code, seq, message)", () => {
    const html = renderToStaticMarkup(
      <VerifyResultView
        result={{
          valid: false,
          errors: [
            { code: "prev_hash", seq: 7, message: "prevHash doesn't match the previous message" },
            { code: "record_signature", message: "platform signature invalid" },
          ],
        }}
      />,
    );
    expect(html).toContain("Verification failed");
    expect(html).toContain("prev_hash");
    expect(html).toContain("(#7)");
    expect(html).toContain("platform signature invalid");
  });

  it("renders a valid result with non-failing notes", () => {
    const html = renderToStaticMarkup(
      <VerifyResultView result={{ valid: true, errors: [], info: [{ code: "content_encrypted", seq: 1, message: "payload is encrypted" }] }} />,
    );
    expect(html).toContain("Verified valid");
    expect(html).toContain("content_encrypted");
  });
});
