"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { InteractionRow, nameOf, useAgentNames } from "../../../../components/app/Interactions";
import ui from "../../../../components/app/ui.module.css";
import { AgentProfile } from "../../../../components/AgentProfile";
import { apiFetch, type OwnerAgent, type OwnerSession } from "../../../../lib/dashboard";
import { buildTimeline } from "../../../../lib/interactions";
import { useOwner } from "../../../../lib/ownerContext";

/** Another agent's profile, from inside the dashboard: its public, verifiable facts first,
 * then every session the owner's own agents had with it. */
export default function CounterpartyPage() {
  const { id } = useParams<{ id: string }>();
  const { owner } = useOwner();
  const [agents, setAgents] = useState<OwnerAgent[]>([]);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200"), apiFetch<{ items: OwnerSession[] }>("/v1/owner/sessions?limit=200")])
      .then(([agentsRes, sessionsRes]) => {
        if (cancelled) return;
        setAgents(agentsRes.items);
        setSessions(sessionsRes.items.filter((s) => s.initiator.agentId === id || s.counterparty.agentId === id));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const history = useMemo(
    () => buildTimeline(sessions, [], { ownerId: owner.id, agentIds: agents.map((a) => a.id) }).filter((i) => i.otherAgentId === id),
    [sessions, agents, owner.id, id],
  );
  const names = useAgentNames([id, ...history.map((i) => i.myAgentId)]);
  const isMine = agents.some((a) => a.id === id);

  return (
    <main className={`${ui.page} ${ui.narrow}`}>
      <p className={ui.crumbs}>
        <a href="/dashboard/counterparties">Counterparties</a> / Profile
      </p>
      {isMine && (
        <p className={ui.hint} style={{ marginBottom: 16 }}>
          This is one of your own agents. Its settings are on <a href={`/dashboard/agents/${id}`}>its agent page</a>.
        </p>
      )}

      <AgentProfile query={{ agentId: id }} />

      <section className={ui.section} style={{ marginTop: 40 }} aria-label="Your history with this agent">
        <div className={ui.sectionHead}>
          <h2 className={ui.h2}>Your history with {nameOf(names, id, "this agent")}</h2>
        </div>
        {!loaded ? (
          <p className="label">Loading…</p>
        ) : history.length === 0 ? (
          <div className={ui.empty}>
            <p>None of your agents has had a session with this agent.</p>
          </div>
        ) : (
          <ul className={ui.rows}>
            {history.map((item) => (
              <InteractionRow key={item.id} item={item} names={names} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
