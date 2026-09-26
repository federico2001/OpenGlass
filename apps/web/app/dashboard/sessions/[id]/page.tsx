"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { StatusBadge } from "../../../../components/StatusBadge";
import {
  ApiError,
  apiFetch,
  formatDate,
  shortHash,
  type AgentPublic,
  type MessageView,
  type Owner,
  type OwnerSession,
  type RecordSummary,
  type VerifyResult,
} from "../../../../lib/dashboard";
import styles from "./page.module.css";

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [participants, setParticipants] = useState<Record<string, AgentPublic>>({});
  const [record, setRecord] = useState<RecordSummary | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [resolvingPause, setResolvingPause] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ session: OwnerSession }>(`/v1/sessions/${id}`),
      apiFetch<{ items: MessageView[] }>(`/v1/sessions/${id}/messages?limit=200`),
      apiFetch<{ owner: Owner }>("/v1/owner/me").catch(() => null),
    ])
      .then(async ([sessionRes, messagesRes, ownerRes]) => {
        if (cancelled) return;
        setSession(sessionRes.session);
        setMessages(messagesRes.items);
        if (ownerRes) setOwner(ownerRes.owner);

        const ids = [sessionRes.session.initiator.agentId, sessionRes.session.counterparty.agentId].filter((v): v is string => !!v);
        const pairs = await Promise.all(
          ids.map((agentId) =>
            apiFetch<{ agent: AgentPublic }>(`/v1/agents/${agentId}`)
              .then((r) => [agentId, r.agent] as const)
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        const map: Record<string, AgentPublic> = {};
        for (const pair of pairs) if (pair) map[pair[0]] = pair[1];
        setParticipants(map);

        if (sessionRes.session.recordId) {
          apiFetch<{ record: RecordSummary }>(`/v1/records/${sessionRes.session.recordId}`)
            .then((r) => {
              if (!cancelled) setRecord(r.record);
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) router.replace(`/login?redirectTo=/dashboard/sessions/${id}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

  async function verifyRecord() {
    if (!session?.recordId) return;
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const bundle = await apiFetch(`/v1/records/${session.recordId}/bundle`);
      const res = await fetch("/v1/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
      const json = (await res.json()) as VerifyResult;
      setVerifyResult(json);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Could not run verification.");
    } finally {
      setVerifying(false);
    }
  }

  if (loading) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Loading…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Not found</p>
        <p className={styles.hint}>
          Either this session doesn&apos;t exist or neither of its agents belongs to you. <a href="/dashboard">Back to dashboard</a>.
        </p>
      </main>
    );
  }

  const initiatorName = session.initiator.agentId ? (participants[session.initiator.agentId]?.name ?? session.initiator.agentId) : "—";
  const counterpartyName = session.counterparty.agentId ? (participants[session.counterparty.agentId]?.name ?? session.counterparty.agentId) : "pending";
  const isParticipantOwner = !!owner && (owner.id === session.initiator.ownerId || owner.id === session.counterparty.ownerId);
  const pauseRequestedByName = session.pause ? (participants[session.pause.requestedBy]?.name ?? session.pause.requestedBy) : null;

  return (
    <main className={`wrap ${styles.main}`}>
      <p className="label"><a href="/dashboard">← Dashboard</a></p>

      <section className={styles.masthead}>
        <div className={styles.headingRow}>
          <h1 className={styles.title}>{session.purpose}</h1>
          <StatusBadge status={session.status} />
        </div>
        <p className={styles.hint}>
          {session.mode === "relay" ? "Relay mode — OpenGlass stores message content" : "Notary mode — OpenGlass stores only message hashes"}
        </p>
      </section>

      {session.status === "paused" && session.pause && (
        <section className={styles.card} aria-label="Paused for human review">
          <p className="label">Paused for review</p>
          <p className={styles.hint}>
            {pauseRequestedByName} paused this session and is waiting for an owner to review before it continues: “{session.pause.reason}”
            {" — "}
            {formatDate(session.pause.requestedAt)}.
          </p>
          {isParticipantOwner ? (
            <div className={styles.buttonRow}>
              <button className={styles.button} onClick={() => resolvePause("resume")} disabled={resolvingPause}>
                {resolvingPause ? "Working…" : "Resume session"}
              </button>
              <button className={styles.secondaryButton} onClick={() => resolvePause("decline-resume")} disabled={resolvingPause}>
                Decline &amp; close
              </button>
            </div>
          ) : (
            <p className={styles.hint}>Only an owner of one of the two participating agents can resume or close this session.</p>
          )}
          {pauseError && <p className={styles.error}>{pauseError}</p>}
        </section>
      )}

      <section className={styles.participants}>
        <div className={styles.participantCard}>
          <p className="label">Initiator</p>
          <p className={styles.participantName}>{initiatorName}</p>
        </div>
        <span className={styles.arrow} aria-hidden="true">→</span>
        <div className={styles.participantCard}>
          <p className="label">Counterparty</p>
          <p className={styles.participantName}>{counterpartyName}</p>
        </div>
      </section>

      <section className={styles.card}>
        <table className={styles.table}>
          <tbody>
            <tr><td>Created</td><td>{formatDate(session.createdAt)}</td></tr>
            <tr><td>Activated</td><td>{formatDate(session.activatedAt)}</td></tr>
            <tr><td>Closed</td><td>{formatDate(session.closedAt)}</td></tr>
            <tr><td>Genesis hash</td><td><code>{shortHash(session.head.hash ? session.head.hash : null)}</code></td></tr>
          </tbody>
        </table>
      </section>

      <section className={styles.section} aria-label="Message timeline">
        <p className="label">Hash-chained messages ({messages.length})</p>
        {messages.length === 0 ? (
          <p className={styles.hint}>No messages yet.</p>
        ) : (
          <ol className={styles.timeline}>
            {messages.map((message) => {
              const senderName = participants[message.envelope.sender.agentId]?.name ?? message.envelope.sender.agentId;
              const text = typeof message.payload?.text === "string" ? message.payload.text : null;
              return (
                <li key={message.id} className={styles.messageItem}>
                  <span className={styles.seqBadge}>{message.seq}</span>
                  <div className={styles.messageBody}>
                    <p className={styles.messageSender}>{senderName}</p>
                    <p className={styles.messageText}>{text ?? "(notary mode — payload not stored by OpenGlass)"}</p>
                    <p className={styles.messageMeta}>
                      hash {shortHash(message.hash)} · signed {message.signature.alg} · countersigned {formatDate(message.receivedAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {session.recordId && (
        <section className={styles.section} aria-label="Record and verification">
          <p className="label">Record</p>
          <div className={styles.card}>
            {record && (
              <table className={styles.table}>
                <tbody>
                  <tr><td>Record ID</td><td><code>{record.id}</code></td></tr>
                  <tr><td>Close reason</td><td>{record.statement.closeReason}</td></tr>
                  <tr><td>Evidence size</td><td>{record.evidence.bytes.toLocaleString()} bytes</td></tr>
                  <tr><td>Issued</td><td>{formatDate(record.statement.issuedAt)}</td></tr>
                </tbody>
              </table>
            )}
            <div className={styles.verifyRow}>
              <button className={styles.button} onClick={verifyRecord} disabled={verifying}>
                {verifying ? "Verifying…" : "Verify independently"}
              </button>
              <a className={styles.downloadLink} href={`/v1/records/${session.recordId}/bundle`}>
                Download bundle
              </a>
            </div>
            <p className={styles.hint}>
              Runs the full cryptographic check (every hash, every signature, against OpenGlass&apos;s published keys) via
              the public <code>POST /v1/verify</code> endpoint — the same check anyone can run without trusting OpenGlass&apos;s word.
            </p>
            {verifyError && <p className={styles.error}>{verifyError}</p>}
            {verifyResult && (
              <div className={verifyResult.valid ? styles.verifyGood : styles.verifyBad}>
                <p className={styles.verifyHeadline}>{verifyResult.valid ? "Verified valid" : "Verification failed"}</p>
                {verifyResult.errors.length > 0 && (
                  <ul className={styles.errorList}>
                    {verifyResult.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
