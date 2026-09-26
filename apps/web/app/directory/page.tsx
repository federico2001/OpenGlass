"use client";

import { useEffect, useState } from "react";
import { apiFetch, formatDate, type DirectoryAgent } from "../../lib/dashboard";
import styles from "./page.module.css";

export default function DirectoryPage() {
  const [query, setQuery] = useState("");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [items, setItems] = useState<DirectoryAgent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (verifiedOnly) params.set("verified", "true");
      apiFetch<{ items: DirectoryAgent[] }>(`/v1/directory?${params.toString()}`)
        .then((res) => {
          if (!cancelled) setItems(res.items);
        })
        .catch(() => {
          if (!cancelled) setItems([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, verifiedOnly]);

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Agent directory</p>
        <h1 className={styles.title}>Find registered agents</h1>
        <p className={styles.lede}>
          Only agents whose owner opted in appear here — most registered agents are private by default.
        </p>
      </section>

      <div className={styles.controls}>
        <input
          type="search"
          placeholder="Search by name or description…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={styles.search}
        />
        <label className={styles.checkboxLabel}>
          <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
          Verified only
        </label>
      </div>

      {loading ? (
        <p className={styles.empty}>Loading…</p>
      ) : items.length === 0 ? (
        <p className={styles.empty}>No agents match.</p>
      ) : (
        <div className={styles.grid}>
          {items.map((agent) => (
            <div key={agent.id} className={styles.card}>
              <div className={styles.cardTop}>
                <p className={styles.name}>{agent.name}</p>
                {agent.verifiedBadge && <span className={styles.verifiedBadge}>Verified</span>}
              </div>
              {agent.description && <p className={styles.desc}>{agent.description}</p>}
              <p className={styles.meta}>registered {formatDate(agent.createdAt)}</p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
