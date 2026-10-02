// Plain-language helpers for the owner dashboard: who is "you" in a session, which way each
// message went, what an attestation entry means, and which other agent an interaction was
// with. Pure functions, so the wording the dashboard shows is unit-tested
// (test/interactions.test.ts) rather than scattered through the pages.

import type { MessageView, OwnerAttestation, OwnerSession } from "./dashboard";

/** Which participant of a session is the signed-in owner's agent. `mine` is null when the
 * viewer only has read access through a viewer grant (neither agent is theirs). When both
 * agents are theirs, the initiator is treated as "theirs" and `bothMine` is set. */
export interface SessionPerspective {
  mine: "initiator" | "counterparty" | null;
  myAgentId: string | null;
  otherAgentId: string | null;
  bothMine: boolean;
}

export function sessionPerspective(
  session: Pick<OwnerSession, "initiator" | "counterparty">,
  viewer: { ownerId?: string | null; agentIds?: Iterable<string> },
): SessionPerspective {
  const agentIds = new Set(viewer.agentIds ?? []);
  const isMine = (side: OwnerSession["initiator"]) =>
    (!!viewer.ownerId && side.ownerId === viewer.ownerId) || (!!side.agentId && agentIds.has(side.agentId));
  const initiatorMine = isMine(session.initiator);
  const counterpartyMine = isMine(session.counterparty);
  if (initiatorMine) {
    return { mine: "initiator", myAgentId: session.initiator.agentId, otherAgentId: session.counterparty.agentId, bothMine: counterpartyMine };
  }
  if (counterpartyMine) {
    return { mine: "counterparty", myAgentId: session.counterparty.agentId, otherAgentId: session.initiator.agentId, bothMine: false };
  }
  return { mine: null, myAgentId: null, otherAgentId: null, bothMine: false };
}

export type Direction = "sent" | "received" | "neutral";

/** "sent" when the viewer's own agent wrote the message, "received" when the other agent
 * did. "neutral" when the viewer is on neither side (viewer-grant access). */
export function messageDirection(senderAgentId: string, perspective: SessionPerspective): Direction {
  if (!perspective.mine) return "neutral";
  return senderAgentId === perspective.myAgentId ? "sent" : "received";
}

export function countDirections(messages: Pick<MessageView, "envelope">[], perspective: SessionPerspective): { sent: number; received: number } {
  let sent = 0;
  let received = 0;
  for (const m of messages) {
    const d = messageDirection(m.envelope.sender.agentId, perspective);
    if (d === "sent") sent += 1;
    else if (d === "received") received += 1;
  }
  return { sent, received };
}

const SESSION_STATUS_PLAIN: Record<string, string> = {
  pending: "Waiting for the other agent to accept",
  active: "In progress",
  paused: "Paused until an owner reviews it",
  closing: "Finishing up",
  closed: "Finished",
  declined: "Declined before it started",
  cancelled: "Cancelled before it started",
  expired: "Expired before it started",
};

const ATTESTATION_STATUS_PLAIN: Record<string, string> = {
  active: "Still being written",
  closing: "Finishing up",
  closed: "Finished",
};

export function plainStatus(kind: "session" | "attestation", status: string): string {
  return (kind === "session" ? SESSION_STATUS_PLAIN : ATTESTATION_STATUS_PLAIN)[status] ?? status;
}

const CLOSE_REASON_PLAIN: Record<string, string> = {
  agent_closed: "An agent closed it",
  idle_timeout: "It ended after a period with no activity",
  agent_suspended: "It ended because an agent was suspended",
  message_limit: "It reached the message limit",
  owner_declined_pause: "An owner declined to resume it after a pause",
};

export function plainCloseReason(reason: string): string {
  return CLOSE_REASON_PLAIN[reason] ?? reason.replace(/_/g, " ");
}

/** A short title and one-line summary for one attestation entry (or a structured session
 * message), read from its payload. The full payload is always available underneath. */
export interface EventDescription {
  title: string;
  summary: string | null;
}

const MAX_SUMMARY = 160;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY ? `${oneLine.slice(0, MAX_SUMMARY - 1)}…` : oneLine;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** "checkup.check_result" → "Check result"; "payment_sent" → "Payment sent". */
export function humanizeType(type: string): string {
  const last = type.includes(".") ? type.slice(type.lastIndexOf(".") + 1) : type;
  const words = last.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : type;
}

export function describeEvent(event: { payload?: unknown }): EventDescription {
  if (!("payload" in event) || event.payload === undefined) {
    return { title: "Entry", summary: "Only a fingerprint of this entry was stored (Notary mode), so there is nothing to summarize." };
  }
  const p = event.payload;
  if (typeof p === "string") return { title: "Note", summary: clip(p) };
  if (!isRecord(p)) return { title: "Entry", summary: null };

  const type = str(p.type);
  // Agent Checkup (apps/checkup) writes these three kinds of entry.
  if (type === "checkup.request_received") {
    const target = isRecord(p.target) ? (str(p.target.cardUrl) ?? str(p.target.origin)) : null;
    return { title: "Checkup requested", summary: target ? `Asked to check the agent at ${target}` : null };
  }
  if (type === "checkup.check_result") {
    const section = str(p.section);
    const score = typeof p.score === "number" ? `score ${p.score}` : null;
    const summary = [score, str(p.summary)].filter(Boolean).join(": ");
    return { title: section ? `Checked the ${section}` : "Check result", summary: summary ? clip(summary) : null };
  }
  if (type === "checkup.report_issued") {
    const overall = typeof p.overall === "number" ? `Overall score ${p.overall}` : null;
    return { title: "Report issued", summary: overall };
  }

  // openglass-policy's evaluateAndAttest (docs/POLICY.md): { event, verdict, counterpartyCheck? }.
  if (isRecord(p.verdict) && str(p.verdict.risk)) {
    const matches = Array.isArray(p.verdict.matches)
      ? p.verdict.matches.map((m) => (isRecord(m) ? str(m.id) : null)).filter((m): m is string => !!m)
      : [];
    return {
      title: `Action checked against its policy: ${p.verdict.risk} risk`,
      summary: matches.length ? `Matched ${matches.join(", ")}` : null,
    };
  }

  const text = str(p.text) ?? str(p.summary) ?? str(p.message) ?? str(p.description);
  if (type) return { title: humanizeType(type), summary: text ? clip(text) : null };
  if (text) return { title: Object.keys(p).length === 1 ? "Message" : "Entry", summary: clip(text) };
  return { title: "Entry", summary: null };
}

/** The other agent an interaction was with: a registered agent, or one known only by its
 * domain and agent card. */
export type CounterpartyRef = { kind: "agent"; agentId: string } | { kind: "domain"; domain: string; agentCardUrl: string | null };

function hostnameOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Reads a counterparty from one payload. An attestation is one-party by design, but the
 * agent may name who its action was about: an explicit `counterparty` object
 * (`{ agentId }`, `{ agentCardUrl }` or `{ domain }`), openglass-policy's `counterpartyCheck`,
 * or Agent Checkup's `target`. Self-reported by the attesting agent, so the dashboard links
 * to the counterparty's profile (verifiable facts only) rather than vouching for it. */
export function counterpartyFromPayload(payload: unknown): CounterpartyRef | null {
  if (!isRecord(payload)) return null;
  const cp = isRecord(payload.counterparty) ? payload.counterparty : null;
  if (cp) {
    const agentId = str(cp.agentId);
    if (agentId) return { kind: "agent", agentId };
    const cardUrl = str(cp.agentCardUrl);
    const domain = (str(cp.domain)?.toLowerCase() ?? null) || (cardUrl ? hostnameOf(cardUrl) : null);
    if (domain) return { kind: "domain", domain, agentCardUrl: cardUrl };
  }
  const check = isRecord(payload.counterpartyCheck) && isRecord(payload.counterpartyCheck.lookup) ? payload.counterpartyCheck.lookup : null;
  if (check && check.registered === true && str(check.agentId)) return { kind: "agent", agentId: check.agentId as string };
  if (payload.type === "checkup.request_received" && isRecord(payload.target)) {
    const cardUrl = str(payload.target.cardUrl);
    const domain = (cardUrl ? hostnameOf(cardUrl) : null) ?? (str(payload.target.origin) ? hostnameOf(payload.target.origin as string) : null);
    if (domain) return { kind: "domain", domain, agentCardUrl: cardUrl };
  }
  return null;
}

/** The first counterparty any entry names, or null. */
export function attestationCounterparty(events: { payload?: unknown }[]): CounterpartyRef | null {
  for (const e of events) {
    const ref = counterpartyFromPayload(e.payload);
    if (ref) return ref;
  }
  return null;
}

export function counterpartyHref(ref: CounterpartyRef): string {
  return ref.kind === "agent"
    ? `/dashboard/counterparties/${encodeURIComponent(ref.agentId)}`
    : `/dashboard/counterparties/by-domain/${encodeURIComponent(ref.domain)}`;
}

/** What one link in the hash chain proves, in plain words, for the evidence panel. */
export const EVIDENCE_EXPLAINED = {
  hash: "A fingerprint of this entry combined with the fingerprint of the one before it. Changing any earlier entry would change every fingerprint after it.",
  signature: "Made with the writing agent's own private key, so only that agent could have produced this entry.",
  countersignature: "OpenGlass's own signature, added the moment it received the entry, fixing when it arrived and where it sits in the order.",
} as const;

// ---- Activity timeline -------------------------------------------------------------

/** One row of the activity timeline: a session (a conversation with another agent) or an
 * attestation (an agent's own log), seen from the signed-in owner's side. */
export interface TimelineItem {
  kind: "session" | "attestation";
  id: string;
  href: string;
  purpose: string;
  status: string;
  createdAt: string;
  /** The owner's agent in this interaction (for a viewer grant, the initiator). */
  myAgentId: string | null;
  /** The other agent in a session; always null for an attestation, which is one-party. */
  otherAgentId: string | null;
  /** Messages in a session, entries in an attestation. */
  count: number;
  recordIssued: boolean;
  /** Best-effort: the purpose looks like openglass-policy rule ids (see looksPolicyFlagged). */
  flagged: boolean;
}

const HUMAN_PURPOSE_HINTS = ["test", "negotiate", "delivery", "purchase", "order"];

/** Best-effort: `evaluateAndAttest` (core-js/core-py, docs/POLICY.md) writes the matched
 * rule ids into an attestation's purpose. The actual risk level lives in each entry's
 * payload, which a list view doesn't fetch, so this is a "looks policy-flagged" signal. */
export function looksPolicyFlagged(purpose: string): boolean {
  if (!purpose) return false;
  const lower = purpose.toLowerCase();
  if (HUMAN_PURPOSE_HINTS.some((hint) => lower.includes(hint))) return false;
  return /^[a-z0-9]+(-[a-z0-9]+)*(,\s*[a-z0-9]+(-[a-z0-9]+)*)*$/.test(purpose.trim()) || purpose === "openglass-policy match";
}

export function buildTimeline(
  sessions: OwnerSession[],
  attestations: OwnerAttestation[],
  viewer: { ownerId?: string | null; agentIds?: Iterable<string> },
): TimelineItem[] {
  const agentIds = [...(viewer.agentIds ?? [])];
  const fromSessions: TimelineItem[] = sessions.map((s) => {
    const p = sessionPerspective(s, { ownerId: viewer.ownerId, agentIds });
    return {
      kind: "session",
      id: s.id,
      href: `/dashboard/sessions/${s.id}`,
      purpose: s.purpose,
      status: s.status,
      createdAt: s.createdAt,
      myAgentId: p.mine ? p.myAgentId : s.initiator.agentId,
      otherAgentId: p.mine ? p.otherAgentId : s.counterparty.agentId,
      count: s.messageCount,
      recordIssued: !!s.recordId,
      flagged: false,
    };
  });
  const fromAttestations: TimelineItem[] = attestations.map((a) => ({
    kind: "attestation",
    id: a.id,
    href: `/dashboard/attestations/${a.id}`,
    purpose: a.purpose,
    status: a.status,
    createdAt: a.createdAt,
    myAgentId: a.attestor.agentId,
    otherAgentId: null,
    count: a.eventCount,
    recordIssued: !!a.recordId,
    flagged: looksPolicyFlagged(a.purpose),
  }));
  return [...fromSessions, ...fromAttestations].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
