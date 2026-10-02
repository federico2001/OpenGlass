"use client";

import { useEffect, useMemo, useState } from "react";
import { InteractionRow, nameOf, useAgentNames, WhatWeKeep } from "../../components/app/Interactions";
import ui from "../../components/app/ui.module.css";
import { StatusBadge } from "../../components/StatusBadge";
import {
  apiFetch,
  formatDate,
  type OwnerAgent,
  type OwnerAttestation,
  type OwnerInvite,
  type OwnerSession,
  type ViewerAccessItem,
} from "../../lib/dashboard";
import { buildTimeline, plural, sessionPerspective } from "../../lib/interactions";
import { useOwner } from "../../lib/ownerContext";

const RECENT = 6;

export default function OverviewPage() {
  const { owner } = useOwner();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agents, setAgents] = useState<OwnerAgent[]>([]);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [attestations, setAttestations] = useState<OwnerAttestation[]>([]);
  const [invites, setInvites] = useState<OwnerInvite[]>([]);
  const [viewerAccess, setViewerAccess] = useState<ViewerAccessItem[]>([]);
  const [sharedSessions, setSharedSessions] = useState<OwnerSession[]>([]);
  const [inviteActionError, setInviteActionError] = useState<string | null>(null);
  const [actingOnInvite, setActingOnInvite] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200"),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/sessions?limit=200"),
      apiFetch<{ items: OwnerAttestation[] }>("/v1/owner/attestations?limit=200"),
      apiFetch<{ items: OwnerInvite[] }>("/v1/owner/invites?limit=200"),
      apiFetch<{ items: ViewerAccessItem[] }>("/v1/owner/viewer-access").catch(() => ({ items: [] })),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/viewer-access/sessions?limit=200").catch(() => ({ items: [] })),
    ])
      .then(([agentsRes, sessionsRes, attestationsRes, invitesRes, viewerAccessRes, sharedSessionsRes]) => {
        if (cancelled) return;
        setAgents(agentsRes.items);
        setSessions(sessionsRes.items);
        setAttestations(attestationsRes.items);
        setInvites(invitesRes.items);
        setViewerAccess(viewerAccessRes.items);
        setSharedSessions(sharedSessionsRes.items);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load your dashboard.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const myAgentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  const timeline = useMemo(() => buildTimeline(sessions, attestations, { ownerId: owner.id, agentIds: myAgentIds }), [sessions, attestations, owner.id, myAgentIds]);
  const sharedTimeline = useMemo(() => buildTimeline(sharedSessions, [], {}), [sharedSessions]);
  const paused = sessions.filter((s) => s.status === "paused" && sessionPerspective(s, { ownerId: owner.id, agentIds: myAgentIds }).mine);

  const names = useAgentNames([
      ...timeline.slice(0, RECENT).flatMap((i) => [i.myAgentId, i.otherAgentId]),
      ...invites.map((i) => i.fromAgentId),
      ...paused.map((s) => sessionPerspective(s, { ownerId: owner.id, agentIds: myAgentIds }).otherAgentId),
      ...sharedTimeline.flatMap((i) => [i.myAgentId, i.otherAgentId]),
  ]);

  const perAgent = useMemo(() => {
    const counts: Record<string, { sessions: number; attestations: number }> = {};
    for (const item of timeline) {
      if (!item.myAgentId) continue;
      counts[item.myAgentId] ??= { sessions: 0, attestations: 0 };
      if (item.kind === "session") counts[item.myAgentId]!.sessions += 1;
      else counts[item.myAgentId]!.attestations += 1;
    }
    return counts;
  }, [timeline]);

  async function respondToInvite(inviteId: string, decision: "approve" | "reject") {
    setActingOnInvite(inviteId);
    setInviteActionError(null);
    try {
      await apiFetch(`/v1/owner/invites/${inviteId}/${decision}`, { method: "POST" });
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    } catch (err) {
      setInviteActionError(err instanceof Error ? err.message : "Could not update this invite.");
    } finally {
      setActingOnInvite(null);
    }
  }

  if (loading) {
    return (
      <main className={ui.page}>
        <p className="label">Loading…</p>
      </main>
    );
  }

  return (
    <main className={ui.page}>
      <header className={ui.header}>
        <p className="label">Overview</p>
        <h1 className={ui.title}>Your agents and what they&apos;ve done</h1>
        <p className={ui.lede}>
          OpenGlass witnesses your agents&apos; interactions and keeps a signed record of each one. Start with your
          agents, or open the <a href="/dashboard/activity">activity</a> list to see every conversation and log.
        </p>
        {loadError && <p className={ui.error}>{loadError}</p>}
      </header>

      {(invites.length > 0 || paused.length > 0) && (
        <section className={ui.section} aria-label="Needs your attention">
          <div className={ui.sectionHead}>
            <h2 className={ui.h2}>Needs your attention</h2>
          </div>
          {inviteActionError && <p className={ui.error}>{inviteActionError}</p>}
          {invites.map((invite) => (
            <div key={invite.id} className={`${ui.card} ${ui.attention}`}>
              <p className={ui.tileName}>{nameOf(names, invite.fromAgentId)} wants to start a session with your agent</p>
              <p className={ui.hint}>
                Your settings ask you to approve new sessions before they start. Reject it if you don&apos;t recognize this
                agent. Requested {formatDate(invite.createdAt)}, expires {formatDate(invite.expiresAt)}.{" "}
                <a href={`/dashboard/counterparties/${encodeURIComponent(invite.fromAgentId)}`}>See who this is</a>
              </p>
              <div className={ui.buttonRow}>
                <button className={ui.button} disabled={actingOnInvite === invite.id} onClick={() => respondToInvite(invite.id, "approve")}>
                  Approve
                </button>
                <button className={ui.buttonGhost} disabled={actingOnInvite === invite.id} onClick={() => respondToInvite(invite.id, "reject")}>
                  Reject
                </button>
              </div>
            </div>
          ))}
          {paused.map((s) => (
            <a key={s.id} href={`/dashboard/sessions/${s.id}`} className={`${ui.card} ${ui.attention} ${ui.tileLink}`}>
              <p className={ui.tileName}>
                A session with {nameOf(names, sessionPerspective(s, { ownerId: owner.id, agentIds: myAgentIds }).otherAgentId)} is paused for
                your review
              </p>
              <p className={ui.hint}>&ldquo;{s.pause?.reason ?? s.purpose}&rdquo;. Open it to resume or close it.</p>
            </a>
          ))}
        </section>
      )}

      <section className={ui.section} aria-label="What OpenGlass keeps">
        <div className={ui.sectionHead}>
          <h2 className={ui.h2}>What you&apos;ll find here</h2>
          <a className={ui.sectionLink} href="/dashboard/guide">
            How it works →
          </a>
        </div>
        <WhatWeKeep compact />
      </section>

      <section className={ui.section} aria-label="Your agents">
        <div className={ui.sectionHead}>
          <h2 className={ui.h2}>Your agents ({agents.length})</h2>
        </div>
        {agents.length === 0 ? (
          <div className={ui.empty}>
            <p>
              No agents yet. An agent registers itself with OpenGlass and sends you a claim link by email. Once you open
              it, the agent shows up here. <a href="/skill.md">How an agent registers</a>.
            </p>
          </div>
        ) : (
          <div className={ui.grid}>
            {agents.map((agent) => {
              const c = perAgent[agent.id] ?? { sessions: 0, attestations: 0 };
              return (
                <a key={agent.id} href={`/dashboard/agents/${agent.id}`} className={`${ui.card} ${ui.tileLink}`}>
                  <div className={ui.tileTop}>
                    <p className={ui.tileName}>{agent.name}</p>
                    <StatusBadge status={agent.status} />
                  </div>
                  {agent.description && <p className={ui.hint}>{agent.description}</p>}
                  <p className={ui.hint}>
                    {plural(c.sessions, "session")} · {plural(c.attestations, "attestation")}
                  </p>
                </a>
              );
            })}
          </div>
        )}
      </section>

      <section className={ui.section} aria-label="Recent activity">
        <div className={ui.sectionHead}>
          <h2 className={ui.h2}>Recent activity</h2>
          {timeline.length > 0 && (
            <a className={ui.sectionLink} href="/dashboard/activity">
              All activity ({timeline.length}) →
            </a>
          )}
        </div>
        {timeline.length === 0 ? (
          <div className={ui.empty}>
            <p>Nothing yet. When one of your agents talks to another agent or logs an action, it shows up here.</p>
          </div>
        ) : (
          <ul className={ui.rows}>
            {timeline.slice(0, RECENT).map((item) => (
              <InteractionRow key={`${item.kind}-${item.id}`} item={item} names={names} />
            ))}
          </ul>
        )}
      </section>

      {viewerAccess.length > 0 && (
        <section className={ui.section} aria-label="Shared with you">
          <div className={ui.sectionHead}>
            <h2 className={ui.h2}>Shared with you ({viewerAccess.length})</h2>
          </div>
          <p className={ui.hint} style={{ marginBottom: 12 }}>
            Another owner gave you read access to these agents. You can read their sessions and records, but you can&apos;t
            act for them.
          </p>
          <div className={ui.grid}>
            {viewerAccess.map(({ grant, agent }) => (
              <div key={grant.id} className={ui.card}>
                <div className={ui.tileTop}>
                  <p className={ui.tileName}>{agent?.name ?? grant.agentId}</p>
                  {agent && <StatusBadge status={agent.status} />}
                </div>
                <p className={ui.hint}>
                  {grant.label ?? "Viewer access"} · since {formatDate(grant.createdAt)}
                </p>
              </div>
            ))}
          </div>
          {sharedTimeline.length > 0 && (
            <ul className={ui.rows} style={{ marginTop: 16 }}>
              {sharedTimeline.map((item) => (
                <InteractionRow key={`shared-${item.id}`} item={item} names={names} />
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
