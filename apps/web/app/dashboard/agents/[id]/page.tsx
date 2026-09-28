"use client";

import { type FormEvent, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { StatusBadge } from "../../../../components/StatusBadge";
import {
  ApiError,
  apiFetch,
  formatDate,
  formatUsdCents,
  type AccessLogEntry,
  type AgentPublic,
  type OwnerAgent,
  type OwnerSession,
  type ViewerGrant,
} from "../../../../lib/dashboard";
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

  const [viewers, setViewers] = useState<ViewerGrant[]>([]);
  const [viewerEmail, setViewerEmail] = useState("");
  const [viewerLabel, setViewerLabel] = useState("");
  const [viewerScope, setViewerScope] = useState<"read" | "export" | "manage">("read");
  const [invitingViewer, setInvitingViewer] = useState(false);
  const [revokingViewerId, setRevokingViewerId] = useState<string | null>(null);
  const [changingScopeId, setChangingScopeId] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>([]);

  const [spendLimitInput, setSpendLimitInput] = useState("");
  const [settingSpendLimit, setSettingSpendLimit] = useState(false);
  const [spendLimitError, setSpendLimitError] = useState<string | null>(null);

  const [retentionInput, setRetentionInput] = useState("");
  const [settingRetention, setSettingRetention] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [settingVisibilityDefault, setSettingVisibilityDefault] = useState(false);

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

        if (found) {
          apiFetch<{ items: ViewerGrant[] }>(`/v1/owner/agents/${id}/viewers?limit=200`)
            .then((r) => {
              if (!cancelled) setViewers(r.items);
            })
            .catch(() => {});
          // Realignment R4 (docs/SPEC.md §15): "an audit log of who viewed what".
          apiFetch<{ items: AccessLogEntry[] }>(`/v1/owner/agents/${id}/access-log?limit=50`)
            .then((r) => {
              if (!cancelled) setAccessLog(r.items);
            })
            .catch(() => {});
        }

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

  async function inviteViewer(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    setInvitingViewer(true);
    setViewerError(null);
    try {
      const res = await apiFetch<{ grant: ViewerGrant }>(`/v1/owner/agents/${agent.id}/viewers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: viewerEmail, label: viewerLabel || null, scope: viewerScope }),
      });
      setViewers((prev) => [res.grant, ...prev.filter((v) => v.id !== res.grant.id)]);
      setViewerEmail("");
      setViewerLabel("");
      setViewerScope("read");
    } catch (err) {
      setViewerError(err instanceof Error ? err.message : "Could not invite this viewer.");
    } finally {
      setInvitingViewer(false);
    }
  }

  async function revokeViewer(grantId: string) {
    if (!agent) return;
    setRevokingViewerId(grantId);
    setViewerError(null);
    try {
      const res = await apiFetch<{ grant: ViewerGrant }>(`/v1/owner/agents/${agent.id}/viewers/${grantId}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      setViewers((prev) => prev.map((v) => (v.id === res.grant.id ? res.grant : v)));
    } catch (err) {
      setViewerError(err instanceof Error ? err.message : "Could not revoke this viewer.");
    } finally {
      setRevokingViewerId(null);
    }
  }

  async function setSpendLimit(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    setSettingSpendLimit(true);
    setSpendLimitError(null);
    try {
      const dollars = Number(spendLimitInput);
      if (!Number.isFinite(dollars) || dollars < 0) throw new Error("Enter a non-negative dollar amount.");
      const res = await apiFetch<{ agent: OwnerAgent }>(`/v1/owner/agents/${agent.id}/spend-limit`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spendLimitUsdCents: Math.round(dollars * 100) }),
      });
      setAgent(res.agent);
      setSpendLimitInput("");
    } catch (err) {
      setSpendLimitError(err instanceof Error ? err.message : "Could not set the spend limit.");
    } finally {
      setSettingSpendLimit(false);
    }
  }

  async function clearSpendLimit() {
    if (!agent) return;
    setSettingSpendLimit(true);
    setSpendLimitError(null);
    try {
      const res = await apiFetch<{ agent: OwnerAgent }>(`/v1/owner/agents/${agent.id}/spend-limit`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spendLimitUsdCents: null }),
      });
      setAgent(res.agent);
    } catch (err) {
      setSpendLimitError(err instanceof Error ? err.message : "Could not clear the spend limit.");
    } finally {
      setSettingSpendLimit(false);
    }
  }

  async function setRetention(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    setSettingRetention(true);
    setRetentionError(null);
    try {
      const days = Number(retentionInput);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Enter a whole number of days, 1–3650.");
      const res = await apiFetch<{ agent: OwnerAgent }>(`/v1/owner/agents/${agent.id}/retention`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ privateRetentionDays: days }),
      });
      setAgent(res.agent);
      setRetentionInput("");
    } catch (err) {
      setRetentionError(err instanceof Error ? err.message : "Could not set retention.");
    } finally {
      setSettingRetention(false);
    }
  }

  async function clearRetention() {
    if (!agent) return;
    setSettingRetention(true);
    setRetentionError(null);
    try {
      const res = await apiFetch<{ agent: OwnerAgent }>(`/v1/owner/agents/${agent.id}/retention`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ privateRetentionDays: null }),
      });
      setAgent(res.agent);
    } catch (err) {
      setRetentionError(err instanceof Error ? err.message : "Could not clear retention.");
    } finally {
      setSettingRetention(false);
    }
  }

  async function setVisibilityDefault(next: "private" | "sealed" | "shared" | null) {
    if (!agent) return;
    setSettingVisibilityDefault(true);
    try {
      const res = await apiFetch<{ agent: OwnerAgent }>(`/v1/owner/agents/${agent.id}/visibility-default`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultVisibility: next }),
      });
      setAgent(res.agent);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not set the default visibility.");
    } finally {
      setSettingVisibilityDefault(false);
    }
  }

  async function changeViewerScope(grantId: string, scope: "read" | "export" | "manage") {
    if (!agent) return;
    setChangingScopeId(grantId);
    setViewerError(null);
    try {
      const res = await apiFetch<{ grant: ViewerGrant }>(`/v1/owner/agents/${agent.id}/viewers/${grantId}/scope`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      setViewers((prev) => prev.map((v) => (v.id === res.grant.id ? res.grant : v)));
    } catch (err) {
      setViewerError(err instanceof Error ? err.message : "Could not change this viewer's scope.");
    } finally {
      setChangingScopeId(null);
    }
  }

  async function toggleDirectory(next: boolean) {
    if (!agent) return;
    setActing(true);
    setActionError(null);
    try {
      const res = await apiFetch<{ agent: OwnerAgent }>(`/v1/owner/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicDirectory: next }),
      });
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
            {agent.meta.homepage && (
              <tr>
                <td>Domain</td>
                <td>
                  <a href={agent.meta.homepage}>{agent.meta.homepage}</a>
                  {agent.domainVerified
                    ? " — verified"
                    : agent.domainVerification?.status === "pending"
                      ? " — verification pending (the agent still needs to publish its token)"
                      : " — not verified"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {agent.meta.homepage && !agent.domainVerified && (
          <p className={styles.hint}>
            Domain verification is a self-service step the agent performs itself, signed with its own key (
            <code>POST /v1/agents/me/domain-verification</code>) — not something to trigger from here.
          </p>
        )}

        {actionError && <p className={styles.error}>{actionError}</p>}
        <button className={styles.button} onClick={toggleSuspend} disabled={acting}>
          {acting ? "Working…" : agent.status === "suspended" ? "Unsuspend agent" : "Suspend agent"}
        </button>
        <p className={styles.hint}>
          {agent.status === "suspended"
            ? "Suspended agents can't create or accept sessions until unsuspended."
            : "Suspending closes any active sessions and cancels pending offers immediately."}
        </p>

        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={agent.publicDirectory}
            disabled={acting}
            onChange={(e) => toggleDirectory(e.target.checked)}
          />
          <span>
            List in the public <a href="/directory">agent directory</a>
          </span>
        </label>
      </section>

      <section className={styles.section} aria-label="Visibility and retention defaults">
        <p className="label">Privacy &amp; retention</p>
        <p className={styles.hint}>
          When this agent offers a session or opens an attestation without specifying visibility itself, this default
          applies — see <a href="/docs/SPEC.md">SPEC.md §13/§15</a> for what each visibility means.
        </p>
        <div className={styles.viewerForm}>
          <select
            value={agent.defaultVisibility ?? ""}
            disabled={settingVisibilityDefault}
            onChange={(e) => setVisibilityDefault(e.target.value === "" ? null : (e.target.value as "private" | "sealed" | "shared"))}
            className={styles.viewerInput}
          >
            <option value="">Platform default</option>
            <option value="private">Private</option>
            <option value="sealed">Sealed</option>
            <option value="shared">Shared</option>
          </select>
        </div>

        <p className={styles.hint} style={{ marginTop: 16 }}>
          For <code>visibility: &quot;private&quot;</code> records this agent participates in as the private-choosing
          party: how many days until content is crypto-shredded.{" "}
          {agent.privateRetentionDays !== null ? (
            <>Currently <strong>{agent.privateRetentionDays} days</strong>.</>
          ) : (
            <>Currently the platform default.</>
          )}
        </p>
        <form onSubmit={setRetention} className={styles.viewerForm}>
          <input
            type="number"
            min="1"
            max="3650"
            step="1"
            placeholder="Days, e.g. 90"
            value={retentionInput}
            onChange={(e) => setRetentionInput(e.target.value)}
            className={styles.viewerInput}
          />
          <button type="submit" className={styles.smallButton} disabled={settingRetention || !retentionInput}>
            {settingRetention ? "Saving…" : "Set retention"}
          </button>
          {agent.privateRetentionDays !== null && (
            <button type="button" className={styles.smallButtonGhost} onClick={clearRetention} disabled={settingRetention}>
              Use platform default
            </button>
          )}
        </form>
        {retentionError && <p className={styles.error}>{retentionError}</p>}
      </section>

      <section className={styles.section} aria-label="Viewers with access to this agent">
        <p className="label">Viewers ({viewers.filter((v) => v.status === "active").length})</p>
        <p className={styles.hint}>
          Give a human — legal, a manager, an auditor — access to this agent&apos;s sessions and records. They sign in
          the same way you did, with a one-time email link. <strong>Read</strong>: view only. <strong>Export</strong>:
          also download a record&apos;s full bundle. <strong>Manage</strong> is reserved — it doesn&apos;t yet grant
          anything beyond export.
        </p>
        <form onSubmit={inviteViewer} className={styles.viewerForm}>
          <input
            type="email"
            required
            placeholder="viewer@company.com"
            value={viewerEmail}
            onChange={(e) => setViewerEmail(e.target.value)}
            className={styles.viewerInput}
          />
          <input
            type="text"
            placeholder="Label (optional) — e.g. Legal counsel"
            value={viewerLabel}
            onChange={(e) => setViewerLabel(e.target.value)}
            className={styles.viewerInput}
            maxLength={100}
          />
          <select value={viewerScope} onChange={(e) => setViewerScope(e.target.value as "read" | "export" | "manage")} className={styles.viewerInput}>
            <option value="read">Read</option>
            <option value="export">Export</option>
            <option value="manage">Manage (reserved)</option>
          </select>
          <button type="submit" className={styles.smallButton} disabled={invitingViewer}>
            {invitingViewer ? "Inviting…" : "Invite viewer"}
          </button>
        </form>
        {viewerError && <p className={styles.error}>{viewerError}</p>}
        {viewers.length > 0 && (
          <ul className={styles.viewerList}>
            {viewers.map((v) => (
              <li key={v.id} className={styles.viewerRow}>
                <div>
                  <p className={styles.viewerEmail}>
                    {v.viewerEmail}
                    {v.label && <span className={styles.viewerLabel}> · {v.label}</span>}
                  </p>
                  <p className={styles.hint}>
                    {v.status === "active" ? "Invited" : "Revoked"} {formatDate(v.status === "active" ? v.createdAt : v.revokedAt)}
                  </p>
                </div>
                <div className={styles.viewerRowActions}>
                  {v.status === "active" ? (
                    <select
                      value={v.scope}
                      disabled={changingScopeId === v.id}
                      onChange={(e) => changeViewerScope(v.id, e.target.value as "read" | "export" | "manage")}
                      className={styles.viewerInput}
                    >
                      <option value="read">Read</option>
                      <option value="export">Export</option>
                      <option value="manage">Manage</option>
                    </select>
                  ) : (
                    <StatusBadge status={v.status} />
                  )}
                  {v.status === "active" && (
                    <button className={styles.smallButtonGhost} onClick={() => revokeViewer(v.id)} disabled={revokingViewerId === v.id}>
                      {revokingViewerId === v.id ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {accessLog.length > 0 && (
          <div className={styles.section} aria-label="Access log">
            <p className="label">Access log</p>
            <ul className={styles.viewerList}>
              {accessLog.map((entry, i) => (
                <li key={i} className={styles.viewerRow}>
                  <div>
                    <p className={styles.viewerEmail}>{entry.viewerEmail}</p>
                    <p className={styles.hint}>
                      {entry.action.replace(/_/g, " ")}
                      {entry.resourceId && <> · {entry.resourceId}</>} · {formatDate(entry.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className={styles.section} aria-label="Spend limit on this agent's paid purchases">
        <p className="label">Spend limit</p>
        <p className={styles.hint}>
          Caps what this agent can spend on paid (x402) features — a verified badge, extended record retention, PDF
          exports. Enforced before payment: a purchase that would go over the cap is refused with no charge.
        </p>
        <p className={styles.hint}>
          Spent so far: <strong>{formatUsdCents(agent.totalSpendUsdCents)}</strong>
          {agent.spendLimitUsdCents !== null && <> of a {formatUsdCents(agent.spendLimitUsdCents)} limit</>}
          {agent.spendLimitUsdCents === null && <> — no limit set</>}
        </p>
        <form onSubmit={setSpendLimit} className={styles.viewerForm}>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Limit in USD, e.g. 5.00"
            value={spendLimitInput}
            onChange={(e) => setSpendLimitInput(e.target.value)}
            className={styles.viewerInput}
          />
          <button type="submit" className={styles.smallButton} disabled={settingSpendLimit || !spendLimitInput}>
            {settingSpendLimit ? "Saving…" : "Set limit"}
          </button>
          {agent.spendLimitUsdCents !== null && (
            <button type="button" className={styles.smallButtonGhost} onClick={clearSpendLimit} disabled={settingSpendLimit}>
              Remove limit
            </button>
          )}
        </form>
        {spendLimitError && <p className={styles.error}>{spendLimitError}</p>}
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
