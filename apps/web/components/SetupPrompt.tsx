"use client";

import { useState } from "react";
import styles from "./SetupPrompt.module.css";

/**
 * The prompt an owner pastes into their coding agent (Claude Code, Codex) to add OpenGlass
 * to their own agent. Shadow mode first, because it never changes what the agent itself
 * sends or receives; side-effecting calls are self-attested instead of fetched twice.
 */
export const SETUP_PROMPT = `Add OpenGlass to my agent as a neutral witness, so its interactions with other agents and APIs end up on a signed, hash-chained record that nobody can quietly change.

1. Install the SDK: npm install openglass-sdk (or pip install openglass-sdk for Python; same methods in snake_case).
2. Register the agent once with client.registerAgent({ name, description }), then show me claim.url so I can claim it. Save client.identity (it holds the agent's private key) in this project's secret store, never in git, and pass it back as identity on startup.
3. Find where the agent calls a counterparty. Start with the calls that matter (money, commitments, data handed to another party) and leave the rest alone.
4. For read-only calls (quotes, lookups, GETs): open an attestation with client.openAttestation({ purpose }) and replace the fetch with client.attestedFetch(attestation.id, url, { mode: "shadow", method, body }). Shadow mode keeps the agent's own request as the real one, so keep using result.direct and its behavior doesn't change.
5. For calls with side effects (payments, orders, writes), don't fetch twice: make the call as before and record it with client.sendAttestationEvent(attestation.id, { text }). Close the attestation with client.closeAttestation(attestation.id) when that task is done.
6. OpenGlass must never break the agent: if an OpenGlass call fails, log it and carry on.
7. Ask me before wrapping anything you're unsure about, then show me the diff.

Docs: https://openglass.glass/skill.md and https://github.com/federico2001/OpenGlass/tree/main/sdk-js`;

export function SetupPrompt() {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(SETUP_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context, permissions): the text is still selectable.
      setExpanded(true);
    }
  }

  return (
    <section className={styles.card} aria-label="Add OpenGlass to your agent">
      <div className={styles.header}>
        <p className={styles.heading}>Add a witness to your agent</p>
        <p className={styles.sub}>Paste this into Claude Code or Codex. It&apos;s set up in under five minutes.</p>
      </div>
      <div className={`${styles.promptBox} ${expanded ? styles.expanded : ""}`}>
        <button type="button" className={styles.copy} onClick={copy} aria-label="Copy prompt">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
        <pre className={styles.prompt}>{SETUP_PROMPT}</pre>
        {!expanded && <div className={styles.fade} aria-hidden="true" />}
      </div>
      <button type="button" className={styles.toggle} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        {expanded ? "Show less" : "Show more"}
      </button>
    </section>
  );
}
