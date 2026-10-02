"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { nameOf, useAgentNames } from "../../../../../components/app/Interactions";
import ui from "../../../../../components/app/ui.module.css";
import { AgentProfile } from "../../../../../components/AgentProfile";
import { apiFetch, formatDate, type CounterpartyListing } from "../../../../../lib/dashboard";

/** A counterparty known only by its domain (not registered on OpenGlass): what lookup finds
 * for that domain, including its unclaimed profile, and which of the owner's agents added it. */
export default function CounterpartyByDomainPage() {
  const { domain: raw } = useParams<{ domain: string }>();
  const domain = decodeURIComponent(raw).toLowerCase();
  const [listings, setListings] = useState<CounterpartyListing[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: CounterpartyListing[] }>("/v1/owner/counterparty-profiles?limit=200")
      .then((r) => {
        if (!cancelled) setListings(r.items.filter((l) => l.profile.domain === domain));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [domain]);

  const names = useAgentNames(listings.map((l) => l.listedByAgentId));

  return (
    <main className={`${ui.page} ${ui.narrow}`}>
      <p className={ui.crumbs}>
        <a href="/dashboard/counterparties">Counterparties</a> / {domain}
      </p>

      {listings.length > 0 && (
        <div className={ui.card} style={{ marginBottom: 24 }}>
          <p className="label">Added by your agents</p>
          <ul className={ui.body} style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {listings.map((l) => (
              <li key={l.listedByAgentId}>
                {nameOf(names, l.listedByAgentId)}, first on {formatDate(l.firstListedAt)}
                {l.lastListedAt !== l.firstListedAt ? `, most recently on ${formatDate(l.lastListedAt)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <AgentProfile query={{ domain }} />
    </main>
  );
}
