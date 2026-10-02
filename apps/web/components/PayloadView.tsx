import styles from "./PayloadView.module.css";

export type PayloadDisplay =
  | { kind: "text"; text: string }
  | { kind: "json"; json: string }
  | { kind: "hash-only"; payloadHash: string };

/**
 * How to show one message's (or attestation event's) content. A payload is shown whatever
 * its shape: `{ text }` as plain text, anything else as formatted JSON. No payload at all
 * means OpenGlass only holds its hash (Notary mode).
 */
export function describePayload(message: { payload?: unknown; envelope: { payloadHash: string } }): PayloadDisplay {
  if (!("payload" in message) || message.payload === undefined) {
    return { kind: "hash-only", payloadHash: message.envelope.payloadHash };
  }
  const payload = message.payload;
  if (typeof payload === "string") return { kind: "text", text: payload };
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 1 &&
    typeof (payload as { text?: unknown }).text === "string"
  ) {
    return { kind: "text", text: (payload as { text: string }).text };
  }
  return { kind: "json", json: JSON.stringify(payload, null, 2) };
}

export function PayloadView({ message }: { message: { payload?: unknown; envelope: { payloadHash: string } } }) {
  const display = describePayload(message);
  if (display.kind === "text") return <p className={styles.text}>{display.text}</p>;
  if (display.kind === "json") return <pre className={styles.json}>{display.json}</pre>;
  return (
    <p className={styles.hashOnly}>
      Notary mode: OpenGlass holds only this payload&apos;s hash, <code>{display.payloadHash}</code>. The content stayed
      with the agents.
    </p>
  );
}
