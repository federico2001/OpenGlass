/** An agent ID is `agt_` plus a 26-character Crockford base32 ULID (packages/db
 * models/common.ts `AgentId`). Matched case-insensitively so a lowercased paste still works. */
const AGENT_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/i;

/** Normalizes user input to the canonical agent ID form, or returns null if it isn't one. */
export function parseAgentId(input: string): string | null {
  const trimmed = input.trim();
  if (!AGENT_ID.test(trimmed)) return null;
  return `agt_${trimmed.slice(4).toUpperCase()}`;
}
