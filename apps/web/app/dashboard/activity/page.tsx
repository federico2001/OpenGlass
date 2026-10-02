"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "../../../components/StatusBadge";
import {
  ApiError,
  apiFetch,
  formatDate,
  type AgentPublic,
  type OwnerAgent,
  type OwnerAttestation,
  type OwnerSession,
} from "../../../lib/dashboard";
import styles from "./page.module.css";

interface TimelineItem {
  kind: "session" | "attestation";
  id: string;
  purpose: string;
  status: string;
  createdAt: string;
  href: string;
  agentId: string | null;
  counterpartyAgentId: string | null;
  /** Best-effort: `evaluateAndAttest` (core-js/core-py's openglass-policy integration)
   * writes matched rule ids into an attestation's `purpose` — see docs/POLICY.md. There's
   * no reliable way to read the actual risk *level* from a list view without an N+1 fetch
   * per attestation (the payload carrying it isn't in the list response), so this is a
   * "looks policy-flagged" signal, not a precise high/medium/low filter. */
  looksPolicyFlagged: boolean;
}

const HUMAN_PURPOSE_HINTS = ["test", "negotiate", "delivery", "purchase", "order"];

function looksPolicyFlagged(purpose: string): boolean {
  if (!purpose) return false;
  const lower = purpose.toLowerCase();
  if (HUMAN_PURPOSE_HINTS.some((hint) => lower.includes(hint))) return false;
  // openglass-policy rule ids are kebab-case, comma-joined (e.g. "financial-transaction,
  // destructive-operation") — a decent heuristic for "this came from evaluateAndAttest".
  return /^[a-z0-9]+(-[a-z0-9]+)*(,\s*[a-z0-9]+(-[a-z0-9]+)*)*$/.test(purpose.trim()) || purpose === "openglass-policy match";
}

export default function ActivityTimelinePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<OwnerAgent[]>([]);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [attestations, setAttestations] = useState<OwnerAttestation[]>([]);
  const [counterparties, setCounterparties] = useState<Record<string, AgentPublic>>({});

  const [agentFilter, setAgentFilter] = useState("");
  const [counterpartyFilter, setCounterpartyFilter] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200"),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/sessions?limit=200"),
      apiFetch<{ items: OwnerAttestation[] }>("/v1/owner/attestations?limit=200"),
    ])
      .then(async ([agentsRes, sessionsRes, attestationsRes]) => {
        if (cancelled) return;
        setAgents(agentsRes.items);
        setSessions(sessionsRes.items);
        setAttestations(attestationsRes.items);

        const myAgentIds = new Set(agentsRes.items.map((a) => a.id));
        const idsToResolve = new Set<string>();
        for (const s of sessionsRes.items) {
          const other = myAgentIds.has(s.initiator.agentId ?? "") ? s.counterparty.agentId : s.initiator.agentId;
          if (other && !myAgentIds.has(other)) idsToResolve.add(other);
        }
        const pairs = await Promise.all(
          [...idsToResolve].map((agentId) =>
            apiFetch<{ agent: AgentPublic }>(`/v1/agents/${agentId}`)
              .then((r) => [agentId, r.agent] as const)
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        const map: Record<string, AgentPublic> = {};
        for (const pair of pairs) if (pair) map[pair[0]] = pair[1];
        setCounterparties(map);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) router.replace("/login?redirectTo=/dashboard/activity");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const myAgentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);

  const items = useMemo<TimelineItem[]>(() => {
    const fromSessions: TimelineItem[] = sessions.map((s) => {
      const mine = myAgentIds.has(s.initiator.agentId ?? "") ? s.initiator.agentId : s.counterparty.agentId;
      const other = mine === s.initiator.agentId ? s.counterparty.agentId : s.initiator.agentId;
      return {
        kind: "session",
        id: s.id,
        purpose: s.purpose,
        status: s.status,
        createdAt: s.createdAt,
        href: `/dashboard/sessions/${s.id}`,
        agentId: mine,
        counterpartyAgentId: other,
        looksPolicyFlagged: false,
      };
    });
    const fromAttestations: TimelineItem[] = attestations.map((a) => ({
      kind: "attestation",
      id: a.id,
      purpose: a.purpose,
      status: a.status,
      createdAt: a.createdAt,
      href: `/dashboard/attestations/${a.id}`,
      agentId: a.attestor.agentId,
      counterpartyAgentId: null, // one-party by design (SPEC §12) — nothing to show here
      looksPolicyFlagged: looksPolicyFlagged(a.purpose),
    }));
    return [...fromSessions, ...fromAttestations].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  }, [sessions, attestations, myAgentIds]);

  const filtered = items.filter((item) => {
    if (agentFilter && item.agentId !== agentFilter) return false;
    if (counterpartyFilter && item.counterpartyAgentId !== counterpartyFilter) return false;
    if (flaggedOnly && !item.looksPolicyFlagged) return false;
    return true;
  });

  const counterpartyOptions = useMemo(() => {
    const ids = new Set(items.map((i) => i.counterpartyAgentId).filter((v): v is string => !!v));
    return [...ids];
  }, [items]);

  if (loading) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Loading…</p>
      </main>
    );
  }

  return (
    <main className={`wrap ${styles.main}`}>
      <p className="label">
        <a href="/dashboard">← Dashboard</a>
      </p>
      <section className={styles.masthead}>
        <p className="label">Realignment R4</p>
        <h1 className={styles.title}>Activity timeline</h1>
        <p className={styles.lede}>
          Every session and attestation across all your agents, newest first. Filter by agent, counterparty, or
          policy-flagged status.
        </p>
      </section>

      <div className={styles.controls}>
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className={styles.select}>
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select value={counterpartyFilter} onChange={(e) => setCounterpartyFilter(e.target.value)} className={styles.select}>
          <option value="">All counterparties</option>
          {counterpartyOptions.map((id) => (
            <option key={id} value={id}>
              {counterparties[id]?.name ?? id}
            </option>
          ))}
        </select>
        <label className={styles.checkboxLabel}>
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
          Policy-flagged only
        </label>
      </div>
      <p className={styles.hint}>
        &ldquo;Policy-flagged&rdquo; is a best-effort read of an attestation&apos;s <code>purpose</code> field (which{" "}
        <code>evaluateAndAttest</code> — see docs/POLICY.md — fills with matched rule ids) — not a guaranteed risk
        level, since that requires fetching each attestation&apos;s events individually.
      </p>

      {filtered.length === 0 ? (
        <p className={styles.hint}>Nothing matches these filters.</p>
      ) : (
        <ul className={styles.list}>
          {filtered.map((item) => (
            <li key={`${item.kind}-${item.id}`}>
              <a href={item.href} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.kindTag}>{item.kind}</span>
                  <p className={styles.purpose}>{item.purpose}</p>
                  <p className={styles.hint}>
                    {item.agentId ? (counterparties[item.agentId]?.name ?? item.agentId) : "—"}
                    {item.counterpartyAgentId && <> → {counterparties[item.counterpartyAgentId]?.name ?? item.counterpartyAgentId}</>}
                    {" · "}
                    {formatDate(item.createdAt)}
                    {item.looksPolicyFlagged && " · policy-flagged"}
                  </p>
                </div>
                <StatusBadge status={item.status} />
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
