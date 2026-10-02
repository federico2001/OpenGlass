"use client";

import { useEffect, useState } from "react";
import { apiFetch, checkRecord, formatDate, type MessageView, type RecordSummary, type VerifyResult } from "../../lib/dashboard";
import { EVIDENCE_EXPLAINED, plainCloseReason } from "../../lib/interactions";
import { VerifyResultView } from "../VerifyResultView";
import ui from "./ui.module.css";
import styles from "./Evidence.module.css";

/** The signed details behind one message or attestation entry, collapsed by default: what
 * each hash and signature is and what it proves. */
export function EvidenceDetails({ message, writer }: { message: MessageView; writer: string }) {
  return (
    <details className={styles.evidence}>
      <summary>Signed details</summary>
      <dl className={styles.evidenceList}>
        <div>
          <dt>Position in the chain</dt>
          <dd>
            #{message.seq}
            <span className={styles.why}>Entries are numbered in the order OpenGlass received them.</span>
          </dd>
        </div>
        <div>
          <dt>Fingerprint (hash)</dt>
          <dd>
            <code>{message.hash}</code>
            <span className={styles.why}>{EVIDENCE_EXPLAINED.hash}</span>
          </dd>
        </div>
        <div>
          <dt>Signed by {writer}</dt>
          <dd>
            <code>
              {message.signature.alg} · key {message.signature.kid}
            </code>
            <span className={styles.why}>{EVIDENCE_EXPLAINED.signature}</span>
          </dd>
        </div>
        <div>
          <dt>Countersigned by OpenGlass</dt>
          <dd>
            <code>
              {message.platformSignature.alg} · key {message.platformSignature.kid}
            </code>{" "}
            at {formatDate(message.receivedAt)}
            <span className={styles.why}>{EVIDENCE_EXPLAINED.countersignature}</span>
          </dd>
        </div>
        <div>
          <dt>Content fingerprint</dt>
          <dd>
            <code>{message.envelope.payloadHash}</code>
            <span className={styles.why}>The hash of the content itself, as {writer} sent it ({message.envelope.contentType}).</span>
          </dd>
        </div>
      </dl>
    </details>
  );
}

const VISIBILITY_PLAIN: Record<string, (kind: "session" | "attestation") => string> = {
  shared: (kind) => (kind === "session" ? "Shared: both owners read the full record." : "Shared with anyone the owner grants access to."),
  private: () => "Private: only the owner who chose it can read it, and the content is erased after its retention period.",
  sealed: () => "Sealed (a legacy setting): only a receipt is available until it is opened.",
};

/** The record issued when a session or attestation ends: what it is, plus independent
 * verification, the bundle download, disputes, and the legacy sealed flow. */
export function RecordPanel({
  recordId,
  kind,
  viewer,
}: {
  recordId: string;
  kind: "session" | "attestation";
  /** `participant`: the viewer owns one side (or the attestor). `soleOwner`: an attestation's
   * owner, who can open a legacy sealed record alone. */
  viewer: { ownerId: string; participant: boolean; soleOwner: boolean };
}) {
  const [record, setRecord] = useState<RecordSummary | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ record: RecordSummary }>(`/v1/records/${recordId}`)
      .then((r) => {
        if (!cancelled) setRecord(r.record);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  async function verify() {
    setVerifying(true);
    setVerifyError(null);
    setVerifyResult(null);
    try {
      const check = await checkRecord(recordId);
      if (check.kind === "verified") setVerifyResult(check.result);
      else setVerifyError("This record is sealed, so only its receipt is available. Once it's opened, the full record can be checked.");
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : "Could not run the check.");
    } finally {
      setVerifying(false);
    }
  }

  async function run(steps: ("unseal-request" | "unseal-approve" | "dispute")[]) {
    setActing(steps[steps.length - 1]!);
    setActionError(null);
    try {
      for (const step of steps) await apiFetch(`/v1/records/${recordId}/${step}`, { method: "POST" });
      const r = await apiFetch<{ record: RecordSummary }>(`/v1/records/${recordId}`);
      setRecord(r.record);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update this record.");
    } finally {
      setActing(null);
    }
  }

  const sealedOpen = record?.visibility === "sealed" && (record.sealedState?.status === "sealed" || record.sealedState?.status === "unseal_requested");
  const approvedByMe = !!record?.sealedState?.approvals.includes(viewer.ownerId);

  return (
    <div className={ui.card}>
      <p className={ui.body}>
        When this {kind} ended, OpenGlass issued a record of it: every {kind === "session" ? "message" : "entry"}, in order,
        with all the signatures, sealed with OpenGlass&apos;s own signature. Anyone holding it can check it without trusting
        OpenGlass.
      </p>
      {record && (
        <table className={ui.table}>
          <tbody>
            <tr>
              <td>Issued</td>
              <td>{formatDate(record.statement.issuedAt)}</td>
            </tr>
            <tr>
              <td>How it ended</td>
              <td>{plainCloseReason(record.statement.closeReason)}</td>
            </tr>
            <tr>
              <td>Who can read it</td>
              <td>{(VISIBILITY_PLAIN[record.visibility ?? "shared"] ?? (() => record.visibility))(kind)}</td>
            </tr>
            <tr>
              <td>Record ID</td>
              <td>
                <code>{record.id}</code>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {record && kind === "session" && record.visibility !== "sealed" && viewer.participant && (
        <div className={ui.hint} aria-label="Dispute status">
          {record.dispute ? (
            <p>
              Disputed by {record.dispute.disputedBy === viewer.ownerId ? "you" : "the other owner"} on {formatDate(record.dispute.disputedAt)}.
              The record itself is unchanged, and both owners keep full access.
            </p>
          ) : (
            <>
              <p>
                Disagree with what this record shows? A dispute flags it for both owners and is counted on each agent&apos;s
                public profile. It doesn&apos;t change or hide the record.
              </p>
              <div className={ui.buttonRow}>
                <button className={ui.buttonGhost} onClick={() => run(["dispute"])} disabled={acting !== null}>
                  {acting === "dispute" ? "Working…" : "Dispute"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {record?.visibility === "sealed" && record.sealedState && (
        <div className={ui.hint} aria-label="Sealed record status">
          {sealedOpen && viewer.soleOwner && (
            <>
              <p>
                This record was issued as sealed (a legacy setting), so only a receipt is available: its hashes and
                signatures, not its content. You&apos;re its only owner, so you can open it.
              </p>
              <div className={ui.buttonRow}>
                <button
                  className={ui.button}
                  onClick={() => run(record.sealedState?.status === "sealed" ? ["unseal-request", "unseal-approve"] : ["unseal-approve"])}
                  disabled={acting !== null}
                >
                  {acting ? "Opening…" : "Open full record"}
                </button>
              </div>
            </>
          )}
          {!viewer.soleOwner && record.sealedState.status === "sealed" && viewer.participant && (
            <>
              <p>
                Sealed (a legacy setting): only a receipt is available until both owners agree to open it, or either one
                disputes it.
              </p>
              <div className={ui.buttonRow}>
                <button className={ui.button} onClick={() => run(["unseal-request"])} disabled={acting !== null}>
                  {acting === "unseal-request" ? "Working…" : "Ask to open it"}
                </button>
                <button className={ui.buttonGhost} onClick={() => run(["dispute"])} disabled={acting !== null}>
                  {acting === "dispute" ? "Working…" : "Dispute"}
                </button>
              </div>
            </>
          )}
          {!viewer.soleOwner && record.sealedState.status === "unseal_requested" && viewer.participant && (
            <>
              <p>{approvedByMe ? "You asked to open it. Waiting for the other owner." : "The other owner asked to open this record."}</p>
              <div className={ui.buttonRow}>
                {!approvedByMe && (
                  <button className={ui.button} onClick={() => run(["unseal-approve"])} disabled={acting !== null}>
                    {acting === "unseal-approve" ? "Working…" : "Agree to open it"}
                  </button>
                )}
                <button className={ui.buttonGhost} onClick={() => run(["dispute"])} disabled={acting !== null}>
                  {acting === "dispute" ? "Working…" : "Dispute instead"}
                </button>
              </div>
            </>
          )}
          {record.sealedState.status === "unsealed" && <p>Opened with both owners&apos; agreement. The full record is available.</p>}
          {record.sealedState.status === "disputed" && <p>Disputed, which opened it for both owners. The full record is available.</p>}
        </div>
      )}
      {actionError && <p className={ui.error}>{actionError}</p>}

      <div className={ui.buttonRow}>
        <button className={ui.button} onClick={verify} disabled={verifying}>
          {verifying ? "Checking…" : "Check this record"}
        </button>
        <a className={ui.buttonGhost} href={`/v1/records/${recordId}/bundle`}>
          Download the record
        </a>
      </div>
      <p className={ui.hint}>
        The check recomputes every hash and checks every signature against OpenGlass&apos;s published keys, using the
        public <code>POST /v1/verify</code> endpoint: the same check anyone can run, or run offline with the SDK.
      </p>
      {verifyError && <p className={ui.error}>{verifyError}</p>}
      {verifyResult && <VerifyResultView result={verifyResult} />}
    </div>
  );
}
