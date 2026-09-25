"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { StatusBadge } from "../../../../components/StatusBadge";
import { ApiError, apiFetch, formatDate, type AgentPublic, type OwnerAgent, type OwnerSession } from "../../../../lib/dashboard";
import styles from "./page.module.css";

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState<OwnerAgent | null>(null);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [counterparties, setCounterparties] = useState<Record<string, AgentPublic>>({});
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200"),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/sessions?limit=200"),
    ])
      .then(([agentsRes, sessionsRes]) => {
        if (cancelled) return;
        const found = agentsRes.items.find((a) => a.id === id) ?? null;
        setAgent(found);
        const mine = sessionsRes.items.filter((s) => s.initiator.agentId === id || s.counterparty.agentId === id);
        setSessions(mine);

        const myAgentIds = new Set(agentsRes.items.map((a) => a.id));
        const idsToResolve = new Set<string>();
        for (const s of mine) {
          const other = s.initiator.agentId === id ? s.counterparty.agentId : s.initiator.agentId;
          if (other && !myAgentIds.has(other)) idsToResolve.add(other);
        }
        Promise.all(
          [...idsToResolve].map((otherId) =>
            apiFetch<{ agent: AgentPublic }>(`/v1/agents/${otherId}`)
              .then((r) => [otherId, r.agent] as const)
              .catch(() => null),
          ),
        ).then((pairs) => {
          if (cancelled) return;
          const map: Record<string, AgentPublic> = {};
          for (const pair of pairs) if (pair) map[pair[0]] = pair[1];
          setCounterparties(map);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) router.replace(`/login?redirectTo=/dashboard/agents/${id}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function toggleSuspend() {
    if (!agent) return;
    setActing(true);
    setActionError(null);
    const action = agent.status === "suspended" ? "unsuspend" : "suspend";
    try {
      const res = await apiFetch<{ agent: OwnerAgent }>(`/v1/owner/agents/${agent.id}/${action}`, { method: "POST" });
      setAgent(res.agent);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update this agent.");
    } finally {
      setActing(false);
    }
  }

  if (loading) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Loading…</p>
      </main>
    );
  }

  if (!agent) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Not found</p>
        <p className={styles.hint}>
          Either this agent doesn&apos;t exist or you&apos;re not its owner. <a href="/dashboard">Back to dashboard</a>.
        </p>
      </main>
    );
  }

  return (
    <main className={`wrap ${styles.main}`}>
      <p className="label"><a href="/dashboard">← Dashboard</a></p>

      <section className={styles.masthead}>
        <div className={styles.headingRow}>
          <h1 className={styles.title}>{agent.name}</h1>
          <StatusBadge status={agent.status} />
        </div>
        {agent.description && <p className={styles.lede}>{agent.description}</p>}
      </section>

      <section className={styles.card}>
        <table className={styles.table}>
          <tbody>
            <tr>
              <td>Fingerprint</td>
              <td><code>{agent.fingerprint}</code></td>
            </tr>
            <tr>
              <td>Agent ID</td>
              <td><code>{agent.id}</code></td>
            </tr>
            <tr>
              <td>Registered</td>
              <td>{formatDate(agent.createdAt)}</td>
            </tr>
            <tr>
              <td>Claimed</td>
              <td>{formatDate(agent.claimedAt)}</td>
            </tr>
            {agent.suspendedAt && (
              <tr>
                <td>Suspended</td>
                <td>{formatDate(agent.suspendedAt)}</td>
              </tr>
            )}
            <tr>
              <td>Verified badge</td>
              <td>{agent.verifiedBadge ? "Yes" : "No"}</td>
            </tr>
          </tbody>
        </table>

        {actionError && <p className={styles.error}>{actionError}</p>}
        <button className={styles.button} onClick={toggleSuspend} disabled={acting}>
          {acting ? "Working…" : agent.status === "suspended" ? "Unsuspend agent" : "Suspend agent"}
        </button>
        <p className={styles.hint}>
          {agent.status === "suspended"
            ? "Suspended agents can't create or accept sessions until unsuspended."
            : "Suspending closes any active sessions and cancels pending offers immediately."}
        </p>
      </section>

      <section className={styles.section} aria-label="Sessions involving this agent">
        <p className="label">Sessions ({sessions.length})</p>
        {sessions.length === 0 ? (
          <p className={styles.hint}>No sessions yet.</p>
        ) : (
          <ul className={styles.sessionList}>
            {sessions.map((session) => {
              const other = session.initiator.agentId === agent.id ? session.counterparty.agentId : session.initiator.agentId;
              const otherName = other ? (counterparties[other]?.name ?? other) : "—";
              return (
                <li key={session.id}>
                  <a href={`/dashboard/sessions/${session.id}`} className={styles.sessionRow}>
                    <div>
                      <p className={styles.sessionPurpose}>{session.purpose}</p>
                      <p className={styles.hint}>with {otherName} · {formatDate(session.createdAt)}</p>
                    </div>
                    <StatusBadge status={session.status} />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
