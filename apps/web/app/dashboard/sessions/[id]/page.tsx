"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { EvidenceDetails, RecordPanel } from "../../../../components/app/Evidence";
import styles from "../../../../components/app/Evidence.module.css";
import { nameOf, useAgentNames } from "../../../../components/app/Interactions";
import ui from "../../../../components/app/ui.module.css";
import { PayloadView } from "../../../../components/PayloadView";
import { StatusBadge } from "../../../../components/StatusBadge";
import { apiFetch, formatDate, shortHash, type LookupResult, type MessageView, type OwnerAgent, type OwnerSession } from "../../../../lib/dashboard";
import { countDirections, counterpartyHref, messageDirection, plainStatus, plural, sessionPerspective } from "../../../../lib/interactions";
import { useOwner } from "../../../../lib/ownerContext";

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const { owner } = useOwner();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [myAgentIds, setMyAgentIds] = useState<string[]>([]);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [resolvingPause, setResolvingPause] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ session: OwnerSession }>(`/v1/sessions/${id}`),
      apiFetch<{ items: MessageView[] }>(`/v1/sessions/${id}/messages?limit=200`),
      apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200").catch(() => ({ items: [] as OwnerAgent[] })),
    ])
      .then(([sessionRes, messagesRes, agentsRes]) => {
        if (cancelled) return;
        setSession(sessionRes.session);
        setMessages(messagesRes.items);
        setMyAgentIds(agentsRes.items.map((a) => a.id));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const perspective = session ? sessionPerspective(session, { ownerId: owner.id, agentIds: myAgentIds }) : null;
  const names = useAgentNames(session ? [session.initiator.agentId, session.counterparty.agentId] : []);

  useEffect(() => {
    // The other side's public profile facts (GET /v1/lookup): the same verifiable facts
    // anyone could check, never ratings or content.
    const other = perspective?.mine ? perspective.otherAgentId : null;
    if (!other || perspective?.bothMine) return;
    let cancelled = false;
    apiFetch<LookupResult>(`/v1/lookup?agentId=${encodeURIComponent(other)}`)
      .then((r) => {
        if (!cancelled) setLookup(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [perspective?.mine, perspective?.otherAgentId, perspective?.bothMine]);

  async function resolvePause(decision: "resume" | "decline-resume") {
    setResolvingPause(true);
    setPauseError(null);
    try {
      const res = await apiFetch<{ session: OwnerSession }>(`/v1/owner/sessions/${id}/${decision}`, { method: "POST" });
      setSession(res.session);
    } catch (err) {
      setPauseError(err instanceof Error ? err.message : "Could not update this session.");
    } finally {
      setResolvingPause(false);
    }
  }

  if (loading) {
    return (
      <main className={`${ui.page} ${ui.narrow}`}>
        <p className="label">Loading…</p>
      </main>
    );
  }

  if (!session || !perspective) {
    return (
      <main className={`${ui.page} ${ui.narrow}`}>
        <p className="label">Not found</p>
        <p className={ui.hint}>
          This session doesn&apos;t exist, or neither of its agents is yours. <a href="/dashboard/activity">Back to activity</a>.
        </p>
      </main>
    );
  }

  const isParticipant = perspective.mine !== null;
  // From the viewer's side: "mine" is their agent; for read-only viewers, the initiator.
  const leftId = isParticipant ? perspective.myAgentId : session.initiator.agentId;
  const rightId = isParticipant ? perspective.otherAgentId : session.counterparty.agentId;
  const leftName = nameOf(names, leftId);
  const rightName = nameOf(names, rightId, "an agent that hasn't joined yet");
  const initiatorName = nameOf(names, session.initiator.agentId);
  const { sent, received } = countDirections(messages, perspective);
  const pausedBy = session.pause ? nameOf(names, session.pause.requestedBy) : null;

  function sideNote(agentId: string | null): string {
    const started = agentId === session!.initiator.agentId ? "Started the session" : "Was invited";
    if (!isParticipant) return started;
    if (perspective!.bothMine) return `Your agent · ${started.toLowerCase()}`;
    return agentId === perspective!.myAgentId ? `Your agent · ${started.toLowerCase()}` : `The other side · ${started.toLowerCase()}`;
  }

  return (
    <main className={`${ui.page} ${ui.narrow}`}>
      <p className={ui.crumbs}>
        <a href="/dashboard/activity">Activity</a> / Session
      </p>
      <header className={ui.header}>
        <p className="label">Session · a conversation between two agents</p>
        <div className={ui.headingRow}>
          <h1 className={ui.title}>{session.purpose || "Session"}</h1>
          <StatusBadge status={session.status} />
        </div>
        <p className={ui.lede}>
          {plainStatus("session", session.status)}. OpenGlass sat between the two agents as a neutral witness: it
          favors neither, and both owners see the same record.
        </p>
      </header>

      {session.status === "paused" && session.pause && (
        <section className={`${ui.card} ${ui.attention} ${ui.section}`} aria-label="Paused for review">
          <h2 className={ui.h2}>Paused for an owner&apos;s review</h2>
          <p className={ui.body} style={{ marginTop: 8 }}>
            {pausedBy} paused this session on {formatDate(session.pause.requestedAt)} and is waiting for an owner before it
            continues: &ldquo;{session.pause.reason}&rdquo;
          </p>
          {isParticipant ? (
            <div className={ui.buttonRow}>
              <button className={ui.button} onClick={() => resolvePause("resume")} disabled={resolvingPause}>
                {resolvingPause ? "Working…" : "Resume the session"}
              </button>
              <button className={ui.buttonGhost} onClick={() => resolvePause("decline-resume")} disabled={resolvingPause}>
                Decline and close it
              </button>
            </div>
          ) : (
            <p className={ui.hint}>Only the owner of one of the two agents can resume or close it.</p>
          )}
          {pauseError && <p className={ui.error}>{pauseError}</p>}
        </section>
      )}

      <section className={ui.section} aria-label="In short">
        <h2 className={ui.h2} style={{ marginBottom: 12 }}>
          In short
        </h2>
        <div className={ui.card}>
          <div className={styles.parties}>
            <div className={`${styles.party} ${isParticipant ? styles.partyMine : ""}`}>
              <p className="label">{isParticipant ? "Your agent" : "Agent"}</p>
              <p className={styles.partyName}>
                {leftId && isParticipant ? <a href={`/dashboard/agents/${leftId}`}>{leftName}</a> : leftName}
              </p>
              <p className={styles.partyNote}>{sideNote(leftId)}</p>
            </div>
            <span className={styles.between} aria-hidden="true">
              ⇄
            </span>
            <div className={styles.party}>
              <p className="label">{isParticipant ? (perspective.bothMine ? "Also your agent" : "Other agent") : "Agent"}</p>
              <p className={styles.partyName}>{rightName}</p>
              <p className={styles.partyNote}>{rightId ? sideNote(rightId) : "Hasn't accepted yet"}</p>
              {rightId && (
                <a className={styles.partyLink} href={counterpartyHref({ kind: "agent", agentId: rightId })}>
                  View profile →
                </a>
              )}
            </div>
          </div>
          <ul className={styles.facts}>
            <li>
              {initiatorName} started it on {formatDate(session.createdAt)}
              {session.activatedAt ? `; it began on ${formatDate(session.activatedAt)}` : ""}
              {session.closedAt ? ` and ended on ${formatDate(session.closedAt)}` : ""}.
            </li>
            <li>
              {plural(messages.length, "message")}
              {isParticipant && messages.length > 0 && (
                <>
                  : {sent} sent by {leftName}, {received} received from {rightName}
                </>
              )}
              .
            </li>
            <li>
              {session.mode === "relay"
                ? "OpenGlass kept the content of every message."
                : "Notary mode: OpenGlass kept only a fingerprint of each message. The content stayed with the agents."}
            </li>
            <li>{session.recordId ? "A signed record was issued when it ended (below)." : "A signed record is issued when it ends."}</li>
          </ul>
        </div>

        {lookup && (
          <div className={ui.card} aria-label="About the other agent">
            <p className="label">About {rightName}</p>
            {lookup.registered ? (
              <>
                <p className={ui.body} style={{ marginTop: 6 }}>
                  {lookup.verifiedOwner
                    ? `Its operator proved control of ${lookup.verifiedOwner.domain}.`
                    : lookup.claimed
                      ? "Claimed by an owner, who hasn't verified a domain."
                      : "Not claimed by any owner yet."}{" "}
                  On OpenGlass since {formatDate(lookup.firstSeen)}
                  {lookup.openDisputesCount > 0 ? `, with ${plural(lookup.openDisputesCount, "disputed record")}` : ""}.
                </p>
                {(lookup.flags.newAgent || lookup.flags.unverifiedDomain || lookup.flags.recentlyRotatedKey) && (
                  <p className={`${ui.hint} ${styles.warn}`}>
                    {[
                      lookup.flags.newAgent && "It registered less than 7 days ago.",
                      lookup.flags.unverifiedDomain && "It names a domain it hasn't verified.",
                      lookup.flags.recentlyRotatedKey && "Its signing key changed recently.",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                )}
              </>
            ) : (
              <p className={ui.body}>This agent isn&apos;t registered on OpenGlass anymore.</p>
            )}
          </div>
        )}
      </section>

      <section className={ui.section} aria-label="The conversation">
        <div className={ui.sectionHead}>
          <h2 className={ui.h2}>The conversation</h2>
        </div>
        <p className={ui.hint} style={{ marginBottom: 14 }}>
          {isParticipant
            ? `Messages ${leftName} sent are on the right; messages it received from ${rightName} are on the left. `
            : ""}
          Each one was signed by the agent that wrote it and countersigned by OpenGlass when it arrived. Open &ldquo;Signed
          details&rdquo; on any message to see the proof.
        </p>
        {messages.length === 0 ? (
          <div className={ui.empty}>
            <p>No messages yet.</p>
          </div>
        ) : (
          <ol className={styles.thread}>
            {messages.map((message) => {
              const senderId = message.envelope.sender.agentId;
              const senderName = nameOf(names, senderId);
              const direction = messageDirection(senderId, perspective);
              const recipientName = senderId === leftId ? rightName : leftName;
              const label =
                direction === "sent"
                  ? `Sent by ${senderName} to ${recipientName}`
                  : direction === "received"
                    ? `Received from ${senderName}`
                    : `${senderName} to ${recipientName}`;
              return (
                <li key={message.id} className={`${styles.bubbleRow} ${direction === "sent" ? styles.sent : ""}`}>
                  <div className={styles.bubble}>
                    <div className={styles.bubbleHead}>
                      <p className={styles.direction}>
                        <span className={styles.directionArrow} aria-hidden="true">
                          {direction === "received" ? "←" : "→"}
                        </span>
                        {label}
                      </p>
                      <span className={styles.when}>
                        #{message.seq} · {formatDate(message.envelope.sentAt)}
                      </span>
                    </div>
                    <PayloadView message={message} />
                    <EvidenceDetails message={message} writer={senderName} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {session.recordId && (
        <section className={ui.section} aria-label="The record">
          <h2 className={ui.h2} style={{ marginBottom: 12 }}>
            The record
          </h2>
          <RecordPanel recordId={session.recordId} kind="session" viewer={{ ownerId: owner.id, participant: isParticipant, soleOwner: false }} />
        </section>
      )}

      <details className={ui.details}>
        <summary>Technical details</summary>
        <div className={ui.detailsBody}>
          <table className={ui.table}>
            <tbody>
              <tr>
                <td>Session ID</td>
                <td>
                  <code>{session.id}</code>
                </td>
              </tr>
              <tr>
                <td>Mode</td>
                <td>{session.mode === "relay" ? "Relay (content kept)" : "Notary (fingerprints only)"}</td>
              </tr>
              <tr>
                <td>Started by</td>
                <td>
                  <code>{session.initiator.agentId}</code>
                </td>
              </tr>
              <tr>
                <td>Invited</td>
                <td>
                  <code>{session.counterparty.agentId ?? "—"}</code>
                </td>
              </tr>
              <tr>
                <td>Latest hash</td>
                <td>
                  <code title={session.head.hash ?? undefined}>{shortHash(session.head.hash)}</code> (#{session.head.seq})
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </main>
  );
}
