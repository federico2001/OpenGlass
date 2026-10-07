"use client";

import { useState } from "react";
import styles from "./SetupPrompt.module.css";

/**
 * The prompt an owner pastes into their coding agent (Claude Code, Codex, or any other) to add
 * OpenGlass to their own agent. Deliberately short: the coding agent asks for what it needs.
 */
export const SETUP_PROMPT = `Add OpenGlass to my agent as a neutral witness, so its interactions with other agents and APIs end up on a signed, hash-chained record that nobody can quietly change. Setup guide: https://openglass.glass/skill.md

Ask me anything you need.`;

export function SetupPrompt() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(SETUP_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context, permissions): the text is still selectable.
    }
  }

  return (
    <section className={styles.card} aria-label="Add OpenGlass to your agent">
      <div className={styles.header}>
        <p className={styles.heading}>Add a witness to your agent (5 minutes)</p>
        <p className={styles.sub}>Prompt for your Claude Code, Codex (or preferred AI)</p>
      </div>
      <div className={styles.promptBox}>
        <button type="button" className={styles.copy} onClick={copy} aria-label="Copy prompt">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M11 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
        <pre className={styles.prompt}>{SETUP_PROMPT}</pre>
      </div>
    </section>
  );
}
