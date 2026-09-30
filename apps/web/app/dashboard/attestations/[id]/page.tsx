"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PayloadView } from "../../../../components/PayloadView";
import { StatusBadge } from "../../../../components/StatusBadge";
import { VerifyResultView } from "../../../../components/VerifyResultView";
import {
  ApiError,
  apiFetch,
  formatDate,
  shortHash,
  checkRecord,
  type AgentPublic,
  type MessageView,
  type OwnerAttestation,
  type RecordSummary,
  type VerifyResult,
} from "../../../../lib/dashboard";
// Same layout as a session's page: an attestation is its one-party counterpart (SPEC §12).
import styles from "../../sessions/[id]/page.module.css";

const VISIBILITY_LABEL: Record<string, string> = {
  private: "Private: only you can read it; the content is erased after its retention period",
  shared: "Shared",
  sealed: "Sealed (legacy)",
};

export default function AttestationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [attestation, setAttestation] = useState<OwnerAttestation | null>(null);
  const [events, setEvents] = useState<MessageView[]>([]);
  const [agent, setAgent] = useState<AgentPublic | null>(null);
  const [record, setRecord] = useState<RecordSummary | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

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
        apiFetch<{ agent: AgentPublic }>(`/v1/agents/${attestationRes.attestation.attestor.agentId}`)
          .then((r) => {
            if (!cancelled) setAgent(r.agent);
          })
          .catch(() => {});
        if (attestationRes.attestation.recordId) {
          apiFetch<{ record: RecordSummary }>(`/v1/records/${attestationRes.attestation.recordId}`)
            .then((r) => {
              if (!cancelled) setRecord(r.record);
            })
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) router.replace(`/login?redirectTo=/dashboard/attestations/${id}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function verifyRecord() {
    if (!attestation?.recordId) return;
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const check = await checkRecord(attestation.recordId);
      if (check.kind === "verified") setVerifyResult(check.result);
      else setVerifyError("This record is sealed, so only its receipt is available. Open it above to verify the full record.");
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Could not run verification.");
    } finally {
      setVerifying(false);
    }
  }

  /** A legacy sealed attestation (SPEC §13.2) has one participant owner: you. Opening it is
   * the ordinary unseal ceremony, with no one else to wait for. */
  async function openSealedRecord() {
    if (!attestation?.recordId || !record) return;
    setOpening(true);
    setOpenError(null);
    try {
      if (record.sealedState?.status === "sealed") {
        await apiFetch(`/v1/records/${attestation.recordId}/unseal-request`, { method: "POST" });
      }
      await apiFetch(`/v1/records/${attestation.recordId}/unseal-approve`, { method: "POST" });
      const r = await apiFetch<{ record: RecordSummary }>(`/v1/records/${attestation.recordId}`);
      setRecord(r.record);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "Could not open this record.");
    } finally {
      setOpening(false);
    }
  }

  if (loading) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Loading…</p>
      </main>
    );
  }

  if (!attestation) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Not found</p>
        <p className={styles.hint}>
          Either this attestation doesn&apos;t exist or its agent doesn&apos;t belong to you. <a href="/dashboard/activity">Back to activity</a>.
        </p>
      </main>
    );
  }

  const agentName = agent?.name ?? attestation.attestor.agentId;

  return (
    <main className={`wrap ${styles.main}`}>
      <p className="label"><a href="/dashboard/activity">← Activity</a></p>

      <section className={styles.masthead}>
        <div className={styles.headingRow}>
          <h1 className={styles.title}>{attestation.purpose || "Attestation"}</h1>
          <StatusBadge status={attestation.status} />
        </div>
        <p className={styles.hint}>
          An attestation is <a href={`/dashboard/agents/${attestation.attestor.agentId}`}>{agentName}</a> logging its own
          actions, with no other agent involved. A conversation with another agent appears as a session instead.{" "}
          {attestation.mode === "relay" ? "Relay mode: OpenGlass stores each event's content." : "Notary mode: OpenGlass stores only each event's hash."}
        </p>
      </section>

      <section className={styles.card}>
        <table className={styles.table}>
          <tbody>
            <tr><td>Agent</td><td>{agentName}</td></tr>
            <tr><td>Visibility</td><td>{VISIBILITY_LABEL[attestation.visibility ?? "shared"] ?? attestation.visibility}</td></tr>
            <tr><td>Opened</td><td>{formatDate(attestation.createdAt)}</td></tr>
            <tr><td>Closed</td><td>{formatDate(attestation.closedAt)}</td></tr>
            <tr><td>Genesis hash</td><td><code>{shortHash(attestation.genesisHash ?? null)}</code></td></tr>
            <tr><td>Latest hash</td><td><code>{shortHash(attestation.head?.hash ?? null)}</code></td></tr>
          </tbody>
        </table>
      </section>

      <section className={styles.section} aria-label="Attested events">
        <p className="label">Hash-chained events ({events.length})</p>
        {events.length === 0 ? (
          <p className={styles.hint}>No events yet.</p>
        ) : (
          <ol className={styles.timeline}>
            {events.map((event) => (
              <li key={event.id} className={styles.messageItem}>
                <span className={styles.seqBadge}>{event.seq}</span>
                <div className={styles.messageBody}>
                  <p className={styles.messageSender}>{event.envelope.contentType}</p>
                  <PayloadView message={event} />
                  <p className={styles.messageMeta}>
                    hash {shortHash(event.hash)} · signed {event.signature.alg} · countersigned {formatDate(event.receivedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {attestation.recordId && (
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
            {record?.visibility === "sealed" && (record.sealedState?.status === "sealed" || record.sealedState?.status === "unseal_requested") && (
              <div className={styles.hint} aria-label="Sealed record">
                <p>
                  This record was issued as sealed (a legacy setting), so only a receipt is available: its hashes and
                  signatures, not its content. You&apos;re its only owner, so you can open it.
                </p>
                <div className={styles.buttonRow}>
                  <button className={styles.button} onClick={openSealedRecord} disabled={opening}>
                    {opening ? "Opening…" : "Open full record"}
                  </button>
                </div>
                {openError && <p className={styles.error}>{openError}</p>}
              </div>
            )}

            <div className={styles.verifyRow}>
              <button className={styles.button} onClick={verifyRecord} disabled={verifying}>
                {verifying ? "Verifying…" : "Verify independently"}
              </button>
              <a className={styles.downloadLink} href={`/v1/records/${attestation.recordId}/bundle`}>
                Download bundle
              </a>
            </div>
            <p className={styles.hint}>
              Runs the full cryptographic check (every hash, every signature, against OpenGlass&apos;s published keys) via
              the public <code>POST /v1/verify</code> endpoint, the same check anyone can run without trusting OpenGlass.
            </p>
            {verifyError && <p className={styles.error}>{verifyError}</p>}
            {verifyResult && <VerifyResultView result={verifyResult} />}
          </div>
        </section>
      )}
    </main>
  );
}
