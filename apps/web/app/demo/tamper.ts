/** Shapes of the parts of a record bundle (SPEC §7.4) the demo page reads. */
export interface DemoMessage {
  envelope: { seq: number; sender: { agentId: string }; sentAt: string };
  payload?: unknown;
}

export interface DemoBundle {
  record: { statement: { recordId: string; purpose: string; issuedAt?: string; participants: { role: string; agentId: string }[] } };
  evidence: { messages: DemoMessage[] };
}

export function messageText(m: DemoMessage): string | null {
  const p = m.payload as { text?: unknown } | undefined;
  return typeof p?.text === "string" ? p.text : null;
}

/**
 * Returns a copy of the bundle with one word changed in the last text message, plus what
 * changed. The first number goes up by one; with no number, "not" goes after the first word.
 */
export function changeOneWord<T extends DemoBundle>(bundle: T): { bundle: T; seq: number; before: string; after: string } | null {
  const copy = structuredClone(bundle);
  const msg = [...copy.evidence.messages].reverse().find((m) => messageText(m) !== null);
  if (!msg) return null;
  const before = messageText(msg)!;
  const after = /\d+/.test(before)
    ? before.replace(/\d+/, (n) => String(Number(n) + 1))
    : before.replace(/^(\S+)/, "$1 not");
  (msg.payload as { text: string }).text = after;
  return { bundle: copy, seq: msg.envelope.seq, before, after };
}
