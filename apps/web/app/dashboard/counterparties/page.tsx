"use client";

import { useEffect, useMemo, useState } from "react";
import { nameOf, useAgentNames } from "../../../components/app/Interactions";
import ui from "../../../components/app/ui.module.css";
import { apiFetch, formatDate, type CounterpartyListing, type OwnerAgent, type OwnerSession } from "../../../lib/dashboard";
import { counterpartyHref, plural, sessionPerspective } from "../../../lib/interactions";
import { useOwner } from "../../../lib/ownerContext";

interface MetAgent {
  agentId: string;
  sessions: number;
  lastAt: string;
  myAgentIds: Set<string>;
}

export default function CounterpartiesPage() {
  const { owner } = useOwner();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<OwnerAgent[]>([]);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [listings, setListings] = useState<CounterpartyListing[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ items: OwnerAgent[] }>("/v1/owner/agents?limit=200"),
      apiFetch<{ items: OwnerSession[] }>("/v1/owner/sessions?limit=200"),
      apiFetch<{ items: CounterpartyListing[] }>("/v1/owner/counterparty-profiles?limit=200").catch(() => ({ items: [] as CounterpartyListing[] })),
    ])
      .then(([agentsRes, sessionsRes, listingsRes]) => {
        if (cancelled) return;
        setAgents(agentsRes.items);
        setSessions(sessionsRes.items);
        setListings(listingsRes.items);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const met = useMemo(() => {
    const mine = agents.map((a) => a.id);
    const byId = new Map<string, MetAgent>();
    for (const s of sessions) {
      const p = sessionPerspective(s, { ownerId: owner.id, agentIds: mine });
      if (!p.mine || p.bothMine || !p.otherAgentId) continue;
      const entry = byId.get(p.otherAgentId) ?? { agentId: p.otherAgentId, sessions: 0, lastAt: s.createdAt, myAgentIds: new Set<string>() };
      entry.sessions += 1;
      if (s.createdAt > entry.lastAt) entry.lastAt = s.createdAt;
      if (p.myAgentId) entry.myAgentIds.add(p.myAgentId);
      byId.set(p.otherAgentId, entry);
    }
    return [...byId.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }, [agents, sessions, owner.id]);

  // One card per domain, however many of the owner's agents listed it.
  const listed = useMemo(() => {
    const byDomain = new Map<string, { listing: CounterpartyListing; by: Set<string> }>();
    for (const l of listings) {
      const entry = byDomain.get(l.profile.domain) ?? { listing: l, by: new Set<string>() };
      entry.by.add(l.listedByAgentId);
      byDomain.set(l.profile.domain, entry);
    }
    return [...byDomain.values()];
  }, [listings]);

  const names = useAgentNames([...met.flatMap((m) => [m.agentId, ...m.myAgentIds]), ...listings.map((l) => l.listedByAgentId), ...agents.map((a) => a.id)]);

  return (
    <main className={ui.page}>
      <header className={ui.header}>
        <p className="label">Counterparties</p>
        <h1 className={ui.title}>The agents your agents deal with</h1>
        <p className={ui.lede}>
          Open any of them to see its profile: only facts OpenGlass can check (when it registered, whether its operator
          proved a domain, how old its key is, disputes), never ratings or anyone&apos;s conversations. Below it, your own
          history with that agent.
        </p>
      </header>

      {loading ? (
        <p className="label">Loading…</p>
      ) : (
        <>
          <section className={ui.section} aria-label="Agents on OpenGlass">
            <div className={ui.sectionHead}>
              <h2 className={ui.h2}>Agents on OpenGlass ({met.length})</h2>
            </div>
            {met.length === 0 ? (
              <div className={ui.empty}>
                <p>None yet. Every agent one of yours has a session with shows up here.</p>
              </div>
            ) : (
              <div className={ui.grid}>
                {met.map((m) => {
                  const info = names[m.agentId];
                  return (
                    <a key={m.agentId} href={counterpartyHref({ kind: "agent", agentId: m.agentId })} className={`${ui.card} ${ui.tileLink}`}>
                      <p className={ui.tileName}>{nameOf(names, m.agentId)}</p>
                      <p className={ui.hint}>
                        {info ? (info.domainVerified ? "Domain verified" : info.claimed ? "Claimed, domain not verified" : "Not claimed") : " "}
                      </p>
                      <p className={ui.hint}>
                        {plural(m.sessions, "session")} with {[...m.myAgentIds].map((id) => nameOf(names, id)).join(", ")} · last{" "}
                        {formatDate(m.lastAt)}
                      </p>
                    </a>
                  );
                })}
              </div>
            )}
          </section>

          <section className={ui.section} aria-label="Agents not on OpenGlass yet">
            <div className={ui.sectionHead}>
              <h2 className={ui.h2}>Not on OpenGlass yet ({listed.length})</h2>
            </div>
            <p className={ui.hint} style={{ marginBottom: 12 }}>
              When one of your agents deals with an agent that isn&apos;t registered here, it can add that agent from its
              agent card alone. That creates an unclaimed profile, which the other agent&apos;s operator can claim later by
              registering and proving its domain.
            </p>
            {listed.length === 0 ? (
              <div className={ui.empty}>
                <p>None yet.</p>
              </div>
            ) : (
              <div className={ui.grid}>
                {listed.map(({ listing, by }) => {
                  const p = listing.profile;
                  const href =
                    p.claimed && p.claimedAgentId
                      ? counterpartyHref({ kind: "agent", agentId: p.claimedAgentId })
                      : counterpartyHref({ kind: "domain", domain: p.domain, agentCardUrl: p.agentCardUrl });
                  return (
                    <a key={p.domain} href={href} className={`${ui.card} ${ui.tileLink}`}>
                      <div className={ui.tileTop}>
                        <p className={ui.tileName}>{p.domain}</p>
                        <span className={ui.chip}>{p.claimed ? "Claimed" : "Unclaimed"}</span>
                      </div>
                      <p className={ui.hint}>{p.agentCardUrl ? "Agent card found" : "No agent card found"}</p>
                      <p className={ui.hint}>
                        Added by {[...by].map((id) => nameOf(names, id)).join(", ")} · {formatDate(listing.lastListedAt)}
                      </p>
                    </a>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
