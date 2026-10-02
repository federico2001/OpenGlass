"use client";

import { useEffect, useState } from "react";
import { apiFetch, formatDate, type AgentPublic } from "../../lib/dashboard";
import { plainStatus, plural, type TimelineItem } from "../../lib/interactions";
import { StatusBadge } from "../StatusBadge";
import ui from "./ui.module.css";

/** The three things OpenGlass keeps, in plain words. Shown on the overview and the guide. */
export function WhatWeKeep({ compact = false }: { compact?: boolean }) {
  return (
    <div className={ui.explainGrid}>
      <div className={ui.explainItem}>
        <span className={`${ui.chip} ${ui.chipSession}`}>Session</span>
        <h3>A conversation between two agents</h3>
        <p>
          Your agent and another agent talk through OpenGlass. Every message, in both directions, is kept in order and
          signed by the agent that sent it.{!compact && " Both owners can read it."}
        </p>
      </div>
      <div className={ui.explainItem}>
        <span className={ui.chip}>Attestation</span>
        <h3>Your agent&apos;s own log</h3>
        <p>
          Your agent writes down something it did, step by step. No other agent writes to it.
          {!compact && " It may mention another agent it acted on, but only your agent signs it."}
        </p>
      </div>
      <div className={ui.explainItem}>
        <span className={ui.chip}>Record</span>
        <h3>The signed copy, issued at the end</h3>
        <p>
          When a session or attestation ends, OpenGlass issues a record of it that anyone can check, without trusting
          OpenGlass.
        </p>
      </div>
    </div>
  );
}

export function KindChip({ kind }: { kind: "session" | "attestation" }) {
  return kind === "session" ? <span className={`${ui.chip} ${ui.chipSession}`}>Session</span> : <span className={ui.chip}>Attestation</span>;
}

/** Display name for an agent id, falling back to the id itself until it resolves. */
export function nameOf(names: Record<string, AgentPublic>, agentId: string | null, fallback = "Unknown agent"): string {
  if (!agentId) return fallback;
  return names[agentId]?.name ?? agentId;
}

/** Resolves public agent names for the given ids (one request per id, cached per page). */
export function useAgentNames(ids: (string | null | undefined)[]): Record<string, AgentPublic> {
  const [names, setNames] = useState<Record<string, AgentPublic>>({});
  const wanted = [...new Set(ids.filter((v): v is string => !!v))].sort().join(",");
  useEffect(() => {
    let cancelled = false;
    const missing = wanted ? wanted.split(",").filter((id) => !names[id]) : [];
    if (missing.length === 0) return;
    Promise.all(
      missing.map((id) =>
        apiFetch<{ agent: AgentPublic }>(`/v1/agents/${encodeURIComponent(id)}`)
          .then((r) => [id, r.agent] as const)
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      setNames((prev) => {
        const next = { ...prev };
        for (const pair of pairs) if (pair) next[pair[0]] = pair[1];
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return names;
}

/** One line of the activity list, saying who did what before anything technical. */
export function InteractionRow({ item, names }: { item: TimelineItem; names: Record<string, AgentPublic> }) {
  const mine = nameOf(names, item.myAgentId);
  const headline =
    item.kind === "session"
      ? `${mine} and ${nameOf(names, item.otherAgentId, "an agent that hasn't joined yet")}`
      : `${mine} logged its own actions`;
  const count = item.kind === "session" ? plural(item.count, "message") : plural(item.count, "entry", "entries");
  return (
    <li>
      <a href={item.href} className={ui.row}>
        <div className={ui.rowMain}>
          <KindChip kind={item.kind} />
          <p className={ui.rowTitle}>{headline}</p>
          <p className={ui.rowSub}>
            {item.purpose ? <>&ldquo;{item.purpose}&rdquo; · </> : null}
            {count} · {formatDate(item.createdAt)}
            {item.flagged && " · flagged by its risk policy"}
          </p>
        </div>
        <div className={ui.rowSide}>
          <StatusBadge status={item.status} />
          <span className={ui.rowNote}>{item.recordIssued ? "Record issued" : plainStatus(item.kind, item.status)}</span>
        </div>
      </a>
    </li>
  );
}
