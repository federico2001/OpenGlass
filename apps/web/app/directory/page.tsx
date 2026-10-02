"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { apiFetch, ApiError, formatDate, type LookupResult, type RegisteredLookupResult } from "../../lib/dashboard";
import { parseAgentId } from "../../lib/agentId";
import styles from "./page.module.css";

type Outcome =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "not-found"; agentId: string }
  | { kind: "error"; message: string }
  | { kind: "found"; result: RegisteredLookupResult };

export default function DirectoryPage() {
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const agentId = parseAgentId(input);
    if (!agentId) {
      setOutcome({ kind: "invalid" });
      return;
    }
    setOutcome({ kind: "loading" });
    try {
      const res = await apiFetch<LookupResult>(`/v1/lookup?${new URLSearchParams({ agentId }).toString()}`);
      setOutcome(res.registered ? { kind: "found", result: res } : { kind: "not-found", agentId });
    } catch (err: unknown) {
      setOutcome({ kind: "error", message: err instanceof ApiError ? err.message : "Something went wrong. Try again." });
    }
  }

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Agent directory</p>
        <h1 className={styles.title}>Find a registered agent</h1>
        <p className={styles.lede}>
          Enter an agent&apos;s ID to open its profile. IDs start with <code>agt_</code>; the agent&apos;s
          owner can find it on their dashboard, and it appears on every record the agent signs.
        </p>
      </section>

      <form className={styles.controls} onSubmit={onSubmit} noValidate>
        <input
          aria-label="Agent ID"
          type="search"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="agt_01J8Z3…"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (outcome.kind === "invalid") setOutcome({ kind: "idle" });
          }}
          aria-invalid={outcome.kind === "invalid"}
          aria-describedby="agent-id-status"
          className={`${styles.search} ${styles.idInput}`}
        />
        <button type="submit" className={styles.button} disabled={outcome.kind === "loading" || input.trim() === ""}>
          Find agent
        </button>
      </form>

      <div id="agent-id-status" aria-live="polite">
        {outcome.kind === "loading" && <p className={styles.empty}>Looking up…</p>}
        {outcome.kind === "invalid" && (
          <p className={styles.empty}>
            That isn&apos;t an agent ID. An agent ID is <code>agt_</code> followed by 26 letters and digits.
          </p>
        )}
        {outcome.kind === "not-found" && (
          <p className={styles.empty}>
            No registered agent has the ID <code>{outcome.agentId}</code>.
          </p>
        )}
        {outcome.kind === "error" && <p className={styles.empty}>{outcome.message}</p>}
        {outcome.kind === "found" && (
          <Link href={`/agents/${outcome.result.agentId}`} className={`${styles.card} ${styles.result}`}>
            <div className={styles.cardTop}>
              <p className={styles.name}>{outcome.result.name}</p>
              {outcome.result.verifiedOwner && <span className={styles.verifiedBadge}>{outcome.result.verifiedOwner.domain}</span>}
            </div>
            <p className={styles.agentId}>{outcome.result.agentId}</p>
            <p className={styles.meta}>
              {outcome.result.claimed ? "claimed by an owner" : "unclaimed"} · first seen {formatDate(outcome.result.firstSeen)}
            </p>
          </Link>
        )}
      </div>
    </main>
  );
}
