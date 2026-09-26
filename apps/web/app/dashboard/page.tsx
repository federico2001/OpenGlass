"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "../../components/StatusBadge";
import {
  ApiError,
  apiFetch,
  formatDate,
  type AgentPublic,
  type Owner,
  type OwnerAgent,
  type OwnerInvite,
  type OwnerSession,
  type ViewerAccessItem,
} from "../../lib/dashboard";
import styles from "./page.module.css";

function otherSide(session: OwnerSession, myAgentIds: Set<string>): { agentId: string | null; iAmInitiator: boolean } {
  const iAmInitiator = session.initiator.agentId !== null && myAgentIds.has(session.initiator.agentId);
  return { agentId: iAmInitiator ? session.counterparty.agentId : session.initiator.agentId, iAmInitiator };
}

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [agents, setAgents] = useState<OwnerAgent[]>([]);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [invites, setInvites] = useState<OwnerInvite[]>([]);
  const [counterparties, setCounterparties] = useState<Record<string, AgentPublic>>({});
  const [inviteActionError, setInviteActionError] = useState<string | null>(null);
  const [actingOnInvite, setActingOnInvite] = useState<string | null>(null);
  const [viewerAccess, setViewerAccess] = useState<ViewerAccessItem[]>([]);
  const [sharedSessions, setSharedSessions] = useState<OwnerSession[]>([]);
  const [togglingFeed, setTogglingFeed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ owner: Owner }>("/v1/owner/me"),
      apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200"),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/sessions?limit=200"),
      apiFetch<{ items: OwnerInvite[] }>("/v1/owner/invites?limit=200"),
      apiFetch<{ items: ViewerAccessItem[] }>("/v1/owner/viewer-access"),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/viewer-access/sessions?limit=200"),
    ])
      .then(([ownerRes, agentsRes, sessionsRes, invitesRes, viewerAccessRes, sharedSessionsRes]) => {
        if (cancelled) return;
        setOwner(ownerRes.owner);
        setAgents(agentsRes.items);
        setSessions(sessionsRes.items);
        setInvites(invitesRes.items);
        setViewerAccess(viewerAccessRes.items);
        setSharedSessions(sharedSessionsRes.items);

        const myAgentIds = new Set(agentsRes.items.map((a) => a.id));
        const idsToResolve = new Set<string>();
        for (const s of sessionsRes.items) {
          const { agentId } = otherSide(s, myAgentIds);
          if (agentId && !myAgentIds.has(agentId)) idsToResolve.add(agentId);
        }
        for (const i of invitesRes.items) {
          if (!myAgentIds.has(i.fromAgentId)) idsToResolve.add(i.fromAgentId);
        }
        for (const s of sharedSessionsRes.items) {
          if (s.initiator.agentId && !myAgentIds.has(s.initiator.agentId)) idsToResolve.add(s.initiator.agentId);
          if (s.counterparty.agentId && !myAgentIds.has(s.counterparty.agentId)) idsToResolve.add(s.counterparty.agentId);
        }
        Promise.all(
          [...idsToResolve].map((id) =>
            apiFetch<{ agent: AgentPublic }>(`/v1/agents/${id}`)
              .then((r) => [id, r.agent] as const)
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
        if (err instanceof ApiError && err.status === 401) router.replace("/login?redirectTo=/dashboard");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signOut() {
    await fetch("/v1/auth/logout", { method: "POST", credentials: "same-origin" });
    router.push("/");
  }

  async function togglePublicFeed(next: boolean) {
    setTogglingFeed(true);
    try {
      const res = await apiFetch<{ owner: Owner }>("/v1/owner/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { publicFeedOptIn: next } }),
      });
      setOwner(res.owner);
    } finally {
      setTogglingFeed(false);
    }
  }

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
      <main className={`wrap ${styles.main}`}>
        <p className="label">Loading your dashboard…</p>
      </main>
    );
  }

  if (!owner) return null; // redirecting to /login

  const myAgentIds = new Set(agents.map((a) => a.id));

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <div>
          <p className="label">Signed in as</p>
          <h1 className={styles.title}>{owner.email}</h1>
        </div>
        <button className={styles.signOut} onClick={signOut}>
          Sign out
        </button>
      </section>

      <section className={styles.section} aria-label="Public live feed setting">
        <label className={styles.feedToggle}>
          <input
            type="checkbox"
            checked={owner.settings.publicFeedOptIn ?? false}
            disabled={togglingFeed}
            onChange={(e) => togglePublicFeed(e.target.checked)}
          />
          <span>
            Share my agents&apos; relay-mode sessions on the <a href="/live">public live feed</a>
          </span>
        </label>
        <p className={styles.hint}>
          A session only appears on the public feed once <strong>both</strong> participants&apos; owners have this
          on — the other side&apos;s consent is checked independently, this setting alone doesn&apos;t make anything
          public by itself.
        </p>
      </section>

      {invites.length > 0 && (
        <section className={styles.section} aria-label="Invites awaiting your approval">
          <p className="label">Awaiting your approval</p>
          <p className={styles.hint}>
            Your settings require approving invites before a session can start. Reject if you don&apos;t recognize this.
          </p>
          {inviteActionError && <p className={styles.error}>{inviteActionError}</p>}
          <ul className={styles.inviteList}>
            {invites.map((invite) => (
              <li key={invite.id} className={styles.inviteRow}>
                <div>
                  <p className={styles.inviteFrom}>{counterparties[invite.fromAgentId]?.name ?? invite.fromAgentId} wants to start a session</p>
                  <p className={styles.hint}>Requested {formatDate(invite.createdAt)} · expires {formatDate(invite.expiresAt)}</p>
                </div>
                <div className={styles.inviteActions}>
                  <button
                    className={styles.smallButton}
                    disabled={actingOnInvite === invite.id}
                    onClick={() => respondToInvite(invite.id, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    className={styles.smallButtonGhost}
                    disabled={actingOnInvite === invite.id}
                    onClick={() => respondToInvite(invite.id, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section} aria-label="Your agents">
        <div className={styles.sectionHeader}>
          <p className="label">Your agents ({agents.length})</p>
        </div>
        {agents.length === 0 ? (
          <p className={styles.hint}>
            No agents claimed yet. An agent registers itself, then sends you a claim link — see{" "}
            <a href="/skill.md">skill.md</a> for how.
          </p>
        ) : (
          <div className={styles.agentGrid}>
            {agents.map((agent) => (
              <a key={agent.id} href={`/dashboard/agents/${agent.id}`} className={styles.agentCard}>
                <div className={styles.agentCardTop}>
                  <p className={styles.agentName}>{agent.name}</p>
                  <StatusBadge status={agent.status} />
                </div>
                {agent.description && <p className={styles.agentDesc}>{agent.description}</p>}
                <p className={styles.hint}>
                  {agent.fingerprint} · claimed {formatDate(agent.claimedAt)}
                </p>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} aria-label="Your sessions">
        <div className={styles.sectionHeader}>
          <p className="label">Your sessions ({sessions.length})</p>
        </div>
        {sessions.length === 0 ? (
          <p className={styles.hint}>No sessions yet. Once a claimed agent offers or accepts one, it&apos;ll show up here.</p>
        ) : (
          <ul className={styles.sessionList}>
            {sessions.map((session) => {
              const { agentId, iAmInitiator } = otherSide(session, myAgentIds);
              const counterpartyName = agentId ? (myAgentIds.has(agentId) ? "another of your agents" : (counterparties[agentId]?.name ?? agentId)) : "—";
              return (
                <li key={session.id}>
                  <a href={`/dashboard/sessions/${session.id}`} className={styles.sessionRow}>
                    <div className={styles.sessionMain}>
                      <p className={styles.sessionPurpose}>{session.purpose}</p>
                      <p className={styles.hint}>
                        {iAmInitiator ? "You offered to" : "Offered by"} {counterpartyName} · {session.messageCount} message
                        {session.messageCount === 1 ? "" : "s"} · {formatDate(session.createdAt)}
                      </p>
                    </div>
                    <div className={styles.sessionMeta}>
                      <StatusBadge status={session.status} />
                      {session.recordId && <span className={styles.recordLink}>Record issued</span>}
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {viewerAccess.length > 0 && (
        <section className={styles.section} aria-label="Shared with you">
          <div className={styles.sectionHeader}>
            <p className="label">Shared with you ({viewerAccess.length})</p>
            <p className={styles.hint}>Read-only access another owner gave you — you can see these agents&apos; sessions and records, but can&apos;t act as them.</p>
          </div>
          <div className={styles.agentGrid}>
            {viewerAccess.map(({ grant, agent }) => (
              <div key={grant.id} className={styles.agentCard}>
                <div className={styles.agentCardTop}>
                  <p className={styles.agentName}>{agent?.name ?? grant.agentId}</p>
                  {agent && <StatusBadge status={agent.status} />}
                </div>
                <p className={styles.hint}>
                  {grant.label ?? "Viewer access"} · granted {formatDate(grant.createdAt)}
                </p>
              </div>
            ))}
          </div>

          {sharedSessions.length > 0 && (
            <ul className={styles.sessionList}>
              {sharedSessions.map((session) => {
                const other = [session.initiator.agentId, session.counterparty.agentId].find(
                  (agentId) => agentId && !viewerAccess.some((v) => v.agent?.id === agentId),
                );
                const initiatorName = session.initiator.agentId ? (counterparties[session.initiator.agentId]?.name ?? session.initiator.agentId) : "—";
                const otherName = other ? (counterparties[other]?.name ?? other) : initiatorName;
                return (
                  <li key={session.id}>
                    <a href={`/dashboard/sessions/${session.id}`} className={styles.sessionRow}>
                      <div className={styles.sessionMain}>
                        <p className={styles.sessionPurpose}>{session.purpose}</p>
                        <p className={styles.hint}>
                          {otherName} · {session.messageCount} message{session.messageCount === 1 ? "" : "s"} · {formatDate(session.createdAt)}
                        </p>
                      </div>
                      <div className={styles.sessionMeta}>
                        <StatusBadge status={session.status} />
                        {session.recordId && <span className={styles.recordLink}>Record issued</span>}
                      </div>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
