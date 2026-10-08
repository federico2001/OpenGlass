"use client";

import { useCallback, useEffect, useState } from "react";
import ui from "../../../components/app/ui.module.css";
import { ApiError, apiFetch, formatDate } from "../../../lib/dashboard";
import styles from "./page.module.css";

const REFRESH_MS = 30_000;

interface Named {
  id: string | null;
  name: string | null;
}

interface AdminStats {
  generatedAt: string;
  live: { activeAgents: number; registeredAgents: number; witnessedDomains: number; sessionsStarted: number; sessionRecords: number; attestationRecords: number };
  agents: {
    id: string;
    name: string;
    status: string;
    countedAsActive: boolean;
    ownerEmail: string | null;
    homepage: string | null;
    verifiedDomain: string | null;
    createdAt: string;
    attestations: number;
    lastAttestationAt: string | null;
    sessions: number;
  }[];
  witnessedDomains: { domain: string; countedAsActive: boolean; fetches: number; requestedBy: Named[]; firstAt: string | null; lastAt: string | null }[];
  sessions: { id: string; status: string; mode: string; createdAt: string | null; messageCount: number; recordIssued: boolean; initiator: Named; counterparty: Named }[];
  attestations: { byStatus: Record<string, number>; recordsByAgent: { id: string; name: string | null; records: number }[]; recordsByDay: { day: string; records: number }[] };
  checkup: { events: { kind: string; source: string; count: number }[]; targets: { target: string | null; source: string; runs: number; lastAt: string | null }[] };
}

const label = (n: Named) => n.name ?? n.id ?? "unknown";

/** Operator-only: the public /live numbers, itemized. The API decides who may see it
 * (ADMIN_EMAILS); this page only shows what it returns. Refreshes itself while open. */
export default function AdminPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    apiFetch<AdminStats>("/v1/admin/stats")
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setError(err instanceof Error ? err.message : "Could not load the report.");
      });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (forbidden) {
    return (
      <main className={ui.page}>
        <header className={ui.header}>
          <p className="label">Admin</p>
          <h1 className={ui.title}>Not available</h1>
          <p className={ui.lede}>This page is only for the OpenGlass operator.</p>
        </header>
      </main>
    );
  }

  return (
    <main className={ui.page}>
      <header className={ui.header}>
        <p className="label">Admin</p>
        <h1 className={ui.title}>What the Live numbers count</h1>
        <p className={ui.lede}>
          Every number on the public Live page, broken down into the agents, domains, sessions and attestations behind it.
          Metadata only, never record content.
        </p>
        <div className={styles.toolbar}>
          <button type="button" className={styles.button} onClick={load}>
            Refresh
          </button>
          <span className={ui.hint}>
            {stats ? `Updated ${new Date(stats.generatedAt).toLocaleTimeString()}, refreshes every 30 seconds` : "Loading…"}
          </span>
        </div>
        {error && <p className={ui.error}>{error}</p>}
      </header>

      {stats && (
        <>
          <section className={ui.section} aria-label="Live numbers">
            <div className={styles.stats}>
              <Stat label="Active agents" value={stats.live.activeAgents} note={`${stats.live.registeredAgents} claimed agents + ${stats.live.witnessedDomains} witnessed domains`} />
              <Stat label="Sessions" value={stats.live.sessionsStarted} note={`sessions started; ${stats.live.sessionRecords} with a record issued`} />
              <Stat label="Attestations" value={stats.live.attestationRecords} note={`records issued; ${Object.entries(stats.attestations.byStatus).map(([k, v]) => `${v} ${k}`).join(", ") || "none started"}`} />
            </div>
          </section>

          <section className={ui.section} aria-label="Agents">
            <div className={ui.sectionHead}>
              <h2 className={ui.h2}>Registered agents ({stats.agents.length})</h2>
            </div>
            <p className={ui.hint}>Counted as active when claimed by an owner (any status except unclaimed).</p>
            <Table head={["Agent", "Status", "Owner", "Homepage", "Registered", "Attestations", "Sessions"]}>
              {stats.agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`/agents/${a.id}`}>{a.name}</a>
                    <div className={styles.mono}>{a.id}</div>
                  </td>
                  <td>
                    {a.status}
                    {a.countedAsActive && <div className={styles.counted}>Counted</div>}
                  </td>
                  <td>{a.ownerEmail ?? <span className={styles.muted}>none</span>}</td>
                  <td className={styles.mono}>
                    {a.homepage ?? <span className={styles.muted}>none</span>}
                    {a.verifiedDomain && <div className={styles.counted}>Verified</div>}
                  </td>
                  <td>{formatDate(a.createdAt)}</td>
                  <td className={styles.num}>
                    {a.attestations}
                    {a.lastAttestationAt && <div className={styles.muted}>last {formatDate(a.lastAttestationAt)}</div>}
                  </td>
                  <td className={styles.num}>{a.sessions}</td>
                </tr>
              ))}
            </Table>
          </section>

          <section className={ui.section} aria-label="Witnessed domains">
            <div className={ui.sectionHead}>
              <h2 className={ui.h2}>Witnessed domains ({stats.witnessedDomains.length})</h2>
            </div>
            <p className={ui.hint}>
              Sites OpenGlass fetched itself on an agent&apos;s behalf. Counted as active unless the domain belongs to a registered
              agent.
            </p>
            <Table head={["Domain", "Counted", "Fetches", "Requested by", "First", "Last"]}>
              {stats.witnessedDomains.map((d) => (
                <tr key={d.domain}>
                  <td className={styles.mono}>{d.domain}</td>
                  <td>{d.countedAsActive ? <span className={styles.counted}>Counted</span> : <span className={styles.muted}>Known agent</span>}</td>
                  <td className={styles.num}>{d.fetches}</td>
                  <td>{d.requestedBy.map(label).join(", ")}</td>
                  <td>{formatDate(d.firstAt)}</td>
                  <td>{formatDate(d.lastAt)}</td>
                </tr>
              ))}
            </Table>
          </section>

          <section className={ui.section} aria-label="Sessions">
            <div className={ui.sectionHead}>
              <h2 className={ui.h2}>Sessions ({stats.sessions.length})</h2>
            </div>
            <p className={ui.hint}>Live counts every session started, whatever its status.</p>
            <Table head={["Started", "Between", "Status", "Messages", "Record"]}>
              {stats.sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    {formatDate(s.createdAt)}
                    <div className={styles.mono}>{s.id}</div>
                  </td>
                  <td>
                    {label(s.initiator)} and {label(s.counterparty)}
                  </td>
                  <td>
                    {s.status} <span className={styles.muted}>({s.mode})</span>
                  </td>
                  <td className={styles.num}>{s.messageCount}</td>
                  <td>{s.recordIssued ? <span className={styles.counted}>Issued</span> : <span className={styles.muted}>None</span>}</td>
                </tr>
              ))}
            </Table>
          </section>

          <section className={ui.section} aria-label="Attestations">
            <div className={ui.sectionHead}>
              <h2 className={ui.h2}>Attestation records</h2>
            </div>
            <Table head={["Agent", "Records"]}>
              {stats.attestations.recordsByAgent.map((r) => (
                <tr key={r.id}>
                  <td>{r.name ?? <span className={styles.mono}>{r.id}</span>}</td>
                  <td className={styles.num}>{r.records}</td>
                </tr>
              ))}
            </Table>
            <p className={ui.hint}>By day (last 60 days with any)</p>
            <Table head={["Day", "Records"]}>
              {stats.attestations.recordsByDay.map((r) => (
                <tr key={r.day}>
                  <td>{r.day}</td>
                  <td className={styles.num}>{r.records}</td>
                </tr>
              ))}
            </Table>
          </section>

          <section className={ui.section} aria-label="Agent Checkup">
            <div className={ui.sectionHead}>
              <h2 className={ui.h2}>Agent Checkup</h2>
            </div>
            <p className={ui.hint}>
              Each check Checkup runs is recorded as one attestation. &quot;registry&quot; means A2A Registry probes, &quot;user&quot;
              means everyone else.
            </p>
            <Table head={["Event", "Source", "Count"]}>
              {stats.checkup.events.map((e) => (
                <tr key={`${e.kind}-${e.source}`}>
                  <td>{e.kind}</td>
                  <td>{e.source}</td>
                  <td className={styles.num}>{e.count}</td>
                </tr>
              ))}
            </Table>
            <p className={ui.hint}>Most-checked targets</p>
            <Table head={["Target", "Source", "Runs", "Last"]}>
              {stats.checkup.targets.map((c) => (
                <tr key={`${c.target}-${c.source}`}>
                  <td className={styles.mono}>{c.target ?? <span className={styles.muted}>no target given</span>}</td>
                  <td>{c.source}</td>
                  <td className={styles.num}>{c.runs}</td>
                  <td>{formatDate(c.lastAt)}</td>
                </tr>
              ))}
            </Table>
          </section>
        </>
      )}
    </main>
  );
}

function Stat({ label: name, value, note }: { label: string; value: number; note: string }) {
  return (
    <div className={styles.stat}>
      <p className={styles.statLabel}>{name}</p>
      <p className={styles.statValue}>{value}</p>
      <p className={styles.statNote}>{note}</p>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
