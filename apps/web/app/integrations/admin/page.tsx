"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiError,
  apiFetch,
  formatDate,
  INTEGRATION_STATUS_LABEL,
  type IntegrationCard,
  type IntegrationRequest,
  type IntegrationStatus,
} from "../../../lib/dashboard";
import styles from "./page.module.css";

const STATUSES: IntegrationStatus[] = ["requested", "in_progress", "available", "native"];

export default function IntegrationsAdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [items, setItems] = useState<IntegrationCard[]>([]);
  const [requests, setRequests] = useState<IntegrationRequest[]>([]);
  const [savingSlug, setSavingSlug] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ items: IntegrationCard[] }>("/v1/integrations"),
      apiFetch<{ items: IntegrationRequest[] }>("/v1/admin/integrations/requests?limit=200"),
    ])
      .then(([catalogRes, requestsRes]) => {
        if (cancelled) return;
        setItems(catalogRes.items);
        setRequests(requestsRes.items);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) router.replace("/login?redirectTo=/integrations/admin");
        else if (err instanceof ApiError && err.status === 403) setForbidden(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function setStatus(slug: string, status: IntegrationStatus): Promise<void> {
    setSavingSlug(slug);
    try {
      await apiFetch(`/v1/admin/integrations/${slug}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setItems((prev) => prev.map((i) => (i.slug === slug ? { ...i, status } : i)));
    } finally {
      setSavingSlug(null);
    }
  }

  if (loading) return <main className="wrap">Loading…</main>;
  if (forbidden) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className={styles.forbidden}>You&apos;re signed in, but this account isn&apos;t an admin.</p>
      </main>
    );
  }

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Integrations admin</p>
        <h1 className={styles.title}>Manage the request board</h1>
      </section>

      <h2 className={styles.sectionTitle}>Framework status</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Framework</th>
            <th>Votes</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.slug}>
              <td>{item.name}</td>
              <td>{item.voteCount}</td>
              <td>
                <select
                  value={item.status}
                  disabled={savingSlug === item.slug}
                  onChange={(e) => setStatus(item.slug, e.target.value as IntegrationStatus)}
                  className={styles.select}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {INTEGRATION_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className={styles.sectionTitle}>Requests</h2>
      {requests.length === 0 ? (
        <p className={styles.empty}>No requests yet.</p>
      ) : (
        <ul className={styles.requestList}>
          {requests.map((r) => (
            <li key={r.id} className={styles.requestItem}>
              <p className={styles.requestName}>
                {r.frameworkName}
                {r.frameworkUrl && (
                  <>
                    {" "}
                    —{" "}
                    <a href={r.frameworkUrl} target="_blank" rel="noreferrer">
                      {r.frameworkUrl}
                    </a>
                  </>
                )}
              </p>
              {r.note && <p className={styles.requestNote}>{r.note}</p>}
              <p className={styles.requestMeta}>
                {r.requesterEmail} · {formatDate(r.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
