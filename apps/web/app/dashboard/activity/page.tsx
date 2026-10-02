"use client";

import { useEffect, useMemo, useState } from "react";
import { InteractionRow, nameOf, useAgentNames } from "../../../components/app/Interactions";
import ui from "../../../components/app/ui.module.css";
import { apiFetch, type OwnerAgent, type OwnerAttestation, type OwnerSession } from "../../../lib/dashboard";
import { buildTimeline } from "../../../lib/interactions";
import { useOwner } from "../../../lib/ownerContext";

type KindFilter = "all" | "session" | "attestation";

export default function ActivityPage() {
  const { owner } = useOwner();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agents, setAgents] = useState<OwnerAgent[]>([]);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [attestations, setAttestations] = useState<OwnerAttestation[]>([]);

  const [kind, setKind] = useState<KindFilter>("all");
  const [agentFilter, setAgentFilter] = useState("");
  const [counterpartyFilter, setCounterpartyFilter] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const k = params.get("kind");
    if (k === "session" || k === "attestation") setKind(k);
    setAgentFilter(params.get("agent") ?? "");
    setCounterpartyFilter(params.get("counterparty") ?? "");

    let cancelled = false;
    Promise.all([
      apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200"),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/sessions?limit=200"),
      apiFetch<{ items: OwnerAttestation[] }>("/v1/owner/attestations?limit=200"),
    ])
      .then(([agentsRes, sessionsRes, attestationsRes]) => {
        if (cancelled) return;
        setAgents(agentsRes.items);
        setSessions(sessionsRes.items);
        setAttestations(attestationsRes.items);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load activity.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(
    () => buildTimeline(sessions, attestations, { ownerId: owner.id, agentIds: agents.map((a) => a.id) }),
    [sessions, attestations, agents, owner.id],
  );
  const names = useAgentNames(items.flatMap((i) => [i.myAgentId, i.otherAgentId]));
  const counterpartyIds = useMemo(() => [...new Set(items.map((i) => i.otherAgentId).filter((v): v is string => !!v))], [items]);

  const filtered = items.filter((item) => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (agentFilter && item.myAgentId !== agentFilter) return false;
    if (counterpartyFilter && item.otherAgentId !== counterpartyFilter) return false;
    if (flaggedOnly && !item.flagged) return false;
    return true;
  });
  const sessionCount = items.filter((i) => i.kind === "session").length;

  return (
    <main className={ui.page}>
      <header className={ui.header}>
        <p className="label">Activity</p>
        <h1 className={ui.title}>Everything your agents did, newest first</h1>
        <p className={ui.lede}>
          A <strong>session</strong> is a conversation between one of your agents and another agent. An{" "}
          <strong>attestation</strong> is one of your agents logging its own actions, with no other agent writing to it.
          Open any line for a plain summary first; the signed details are one click further.{" "}
          <a href="/dashboard/guide">How it works</a>
        </p>
      </header>

      <div className={ui.controls}>
        <div className={ui.segmented} role="group" aria-label="Show">
          {(
            [
              ["all", `All (${items.length})`],
              ["session", `Sessions (${sessionCount})`],
              ["attestation", `Attestations (${items.length - sessionCount})`],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>
              {label}
            </button>
          ))}
        </div>
        <select aria-label="Agent" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className={ui.select}>
          <option value="">All my agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {counterpartyIds.length > 0 && kind !== "attestation" && (
          <select aria-label="Counterparty" value={counterpartyFilter} onChange={(e) => setCounterpartyFilter(e.target.value)} className={ui.select}>
            <option value="">Any counterparty</option>
            {counterpartyIds.map((id) => (
              <option key={id} value={id}>
                {nameOf(names, id)}
              </option>
            ))}
          </select>
        )}
        {kind !== "session" && (
          <label className={ui.toggle} style={{ fontSize: 13.5 }}>
            <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} />
            <span>Only attestations flagged by a risk policy</span>
          </label>
        )}
      </div>
      {flaggedOnly && (
        <p className={ui.hint} style={{ marginBottom: 12 }}>
          An attestation counts as flagged when its purpose lists <code>openglass-policy</code> rule ids, which is how{" "}
          <code>evaluateAndAttest</code> names them. The exact risk level is inside each attestation.
        </p>
      )}
      {loadError && <p className={ui.error}>{loadError}</p>}

      {loading ? (
        <p className="label">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className={ui.empty}>
          <p>{items.length === 0 ? "Nothing yet. When one of your agents talks to another agent or logs an action, it shows up here." : "Nothing matches these filters."}</p>
        </div>
      ) : (
        <ul className={ui.rows}>
          {filtered.map((item) => (
            <InteractionRow key={`${item.kind}-${item.id}`} item={item} names={names} />
          ))}
        </ul>
      )}
    </main>
  );
}
