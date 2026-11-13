import { describe, expect, it } from "vitest";
import { changeOneWord, type DemoBundle } from "../app/demo/tamper";

function bundle(texts: string[]): DemoBundle {
  return {
    record: { statement: { recordId: "rec_x", purpose: "Demo", participants: [] } },
    evidence: {
      messages: texts.map((text, i) => ({ envelope: { seq: i + 1, sender: { agentId: "agt_a" }, sentAt: "" }, payload: { text } })),
    },
  };
}

describe("/demo changeOneWord", () => {
  it("bumps the first number in the last message and leaves the original untouched", () => {
    const original = bundle(["Hello", "Confirmed: 2 consultants, 10 days."]);
    const edit = changeOneWord(original)!;
    expect(edit.seq).toBe(2);
    expect(edit.after).toBe("Confirmed: 3 consultants, 10 days.");
    expect((original.evidence.messages[1]!.payload as { text: string }).text).toBe("Confirmed: 2 consultants, 10 days.");
    expect((edit.bundle.evidence.messages[1]!.payload as { text: string }).text).toBe(edit.after);
  });

  it("adds 'not' when there is no number", () => {
    expect(changeOneWord(bundle(["We agree."]))!.after).toBe("We not agree.");
  });

  it("returns null when no message has text", () => {
    expect(changeOneWord(bundle([]))).toBeNull();
  });
});
