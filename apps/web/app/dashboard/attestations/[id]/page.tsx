"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { EvidenceDetails, RecordPanel } from "../../../../components/app/Evidence";
import styles from "../../../../components/app/Evidence.module.css";
import { nameOf, useAgentNames } from "../../../../components/app/Interactions";
import ui from "../../../../components/app/ui.module.css";
import { PayloadView } from "../../../../components/PayloadView";
import { StatusBadge } from "../../../../components/StatusBadge";
import { apiFetch, formatDate, shortHash, type MessageView, type OwnerAttestation } from "../../../../lib/dashboard";
import { attestationCounterparty, counterpartyHref, describeEvent, plainStatus, plural } from "../../../../lib/interactions";
import { useOwner } from "../../../../lib/ownerContext";

const VISIBILITY_PLAIN: Record<string, string> = {
  private: "Private: only you can read it, and its content is erased after its retention period.",
  shared: "Shared: you and anyone you give viewer access can read it.",
  sealed: "Sealed (a legacy setting): only a receipt is available until you open it.",
};

export default function AttestationPage() {
  const { id } = useParams<{ id: string }>();
  const { owner } = useOwner();
  const [loading, setLoading] = useState(true);
  const [attestation, setAttestation] = useState<OwnerAttestation | null>(null);
  const [events, setEvents] = useState<MessageView[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ attestation: OwnerAttestation }>(`/v1/attestations/${id}`),
      apiFetch<{ items: MessageView[] }>(`/v1/attestations/${id}/events?limit=200`),
    ])
      .then(([attestationRes, eventsRes]) => {
        if (cancelled) return;
        setAttestation(attestationRes.attestation);
        setEvents(eventsRes.items);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const about = attestationCounterparty(events);
  const names = useAgentNames([attestation?.attestor.agentId, about?.kind === "agent" ? about.agentId : null]);

  if (loading) {
    return (
      <main className={`${ui.page} ${ui.narrow}`}>
        <p className="label">Loading…</p>
      </main>
    );
  }

  if (!attestation) {
    return (
      <main className={`${ui.page} ${ui.narrow}`}>
        <p className="label">Not found</p>
        <p className={ui.hint}>
          This attestation doesn&apos;t exist, or its agent isn&apos;t yours. <a href="/dashboard/activity">Back to activity</a>.
        </p>
      </main>
    );
  }

  const agentId = attestation.attestor.agentId;
  const agentName = nameOf(names, agentId);
  const aboutLabel = about ? (about.kind === "agent" ? about.agentId : about.domain) : null;
  const isOwner = attestation.attestor.ownerId === owner.id;
  const first = events[0];
  const last = events[events.length - 1];

  return (
    <main className={`${ui.page} ${ui.narrow}`}>
      <p className={ui.crumbs}>
        <a href="/dashboard/activity">Activity</a> / Attestation
      </p>
      <header className={ui.header}>
        <p className="label">Attestation · an agent&apos;s own log</p>
        <div className={ui.headingRow}>
          <h1 className={ui.title}>{attestation.purpose || "Attestation"}</h1>
          <StatusBadge status={attestation.status} />
        </div>
        <p className={ui.lede}>
          {plainStatus("attestation", attestation.status)}. This is {agentName} writing down what it did, step by step. No
          other agent wrote to it: there is nothing here that {agentName} sent to or received from another agent. A
          conversation with another agent shows up as a session instead.
        </p>
      </header>

      <section className={ui.section} aria-label="In short">
        <h2 className={ui.h2} style={{ marginBottom: 12 }}>
          In short
        </h2>
        <div className={ui.card}>
          <ul className={styles.facts} style={{ marginTop: 0 }}>
            <li>
              Written and signed by{" "}
              <a href={isOwner ? `/dashboard/agents/${agentId}` : `/agents/${agentId}`}>
                {agentName}
              </a>
              {isOwner ? ", your agent" : ""}.
            </li>
            <li>
              {plural(events.length, "entry", "entries")}
              {first && last ? `, from ${formatDate(first.receivedAt)} to ${formatDate(last.receivedAt)}` : ""}.
            </li>
            {about && (
              <li>
                It&apos;s about another agent: <a href={counterpartyHref(about)}>{about.kind === "agent" ? nameOf(names, about.agentId) : aboutLabel}</a>.{" "}
                <span className={ui.hint}>{agentName} named it in its own entries; OpenGlass doesn&apos;t vouch for that agent.</span>
              </li>
            )}
            <li>
              {attestation.mode === "relay"
                ? "OpenGlass kept the content of every entry."
                : "Notary mode: OpenGlass kept only a fingerprint of each entry. The content stayed with the agent."}
            </li>
            <li>{VISIBILITY_PLAIN[attestation.visibility ?? "private"] ?? attestation.visibility}</li>
          </ul>
        </div>
      </section>

      <section className={ui.section} aria-label="Entries">
        <div className={ui.sectionHead}>
          <h2 className={ui.h2}>What {agentName} logged</h2>
        </div>
        <p className={ui.hint} style={{ marginBottom: 14 }}>
          In the order OpenGlass received them. Each one links to the one before it, so none can be changed, removed or
          reordered without breaking every link after it. Open &ldquo;Full entry&rdquo; for the exact content and
          &ldquo;Signed details&rdquo; for the proof.
        </p>
        {events.length === 0 ? (
          <div className={ui.empty}>
            <p>No entries yet.</p>
          </div>
        ) : (
          <ol className={styles.thread}>
            {events.map((event) => {
              const d = describeEvent(event);
              return (
                <li key={event.id} className={styles.entry}>
                  <span className={styles.entryNum}>{event.seq}</span>
                  <div className={styles.entryBody}>
                    <p className={styles.entryTitle}>{d.title}</p>
                    {d.summary && <p className={styles.entrySummary}>{d.summary}</p>}
                    <p className={styles.entryMeta}>
                      Written by {agentName} · {formatDate(event.envelope.sentAt)}
                    </p>
                    {event.payload !== undefined && (
                      <details className={styles.evidence}>
                        <summary>Full entry</summary>
                        <div className={styles.content}>
                          <PayloadView message={event} />
                        </div>
                      </details>
                    )}
                    <EvidenceDetails message={event} writer={agentName} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {attestation.recordId && (
        <section className={ui.section} aria-label="The record">
          <h2 className={ui.h2} style={{ marginBottom: 12 }}>
            The record
          </h2>
          <RecordPanel recordId={attestation.recordId} kind="attestation" viewer={{ ownerId: owner.id, participant: isOwner, soleOwner: isOwner }} />
        </section>
      )}

      <details className={ui.details}>
        <summary>Technical details</summary>
        <div className={ui.detailsBody}>
          <table className={ui.table}>
            <tbody>
              <tr>
                <td>Attestation ID</td>
                <td>
                  <code>{attestation.id}</code>
                </td>
              </tr>
              <tr>
                <td>Agent ID</td>
                <td>
                  <code>{agentId}</code>
                </td>
              </tr>
              <tr>
                <td>Opened</td>
                <td>{formatDate(attestation.createdAt)}</td>
              </tr>
              <tr>
                <td>Closed</td>
                <td>{formatDate(attestation.closedAt)}</td>
              </tr>
              <tr>
                <td>First hash (genesis)</td>
                <td>
                  <code title={attestation.genesisHash}>{shortHash(attestation.genesisHash ?? null)}</code>
                </td>
              </tr>
              <tr>
                <td>Latest hash</td>
                <td>
                  <code title={attestation.head?.hash ?? undefined}>{shortHash(attestation.head?.hash ?? null)}</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </main>
  );
}
