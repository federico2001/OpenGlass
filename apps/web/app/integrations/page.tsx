"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiFetch, INTEGRATION_STATUS_LABEL, type IntegrationCard } from "../../lib/dashboard";
import styles from "./page.module.css";

export default function IntegrationsPage() {
  const [items, setItems] = useState<IntegrationCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [voting, setVoting] = useState<Set<string>>(new Set());

  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formNote, setFormNote] = useState("");
  const [formStatus, setFormStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");

  function load(): void {
    setLoading(true);
    apiFetch<{ items: IntegrationCard[] }>("/v1/integrations")
      .then((res) => setItems(res.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    apiFetch("/v1/owner/me")
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, []);

  function goToLogin(): void {
    window.location.href = "/login?redirectTo=/integrations";
  }

  async function toggleVote(item: IntegrationCard): Promise<void> {
    if (!signedIn) return goToLogin();
    setVoting((s) => new Set(s).add(item.slug));
    try {
      const method = item.hasVoted ? "DELETE" : "POST";
      const res = await apiFetch<{ voteCount: number }>(`/v1/integrations/${item.slug}/vote`, { method });
      setItems((prev) => prev.map((i) => (i.slug === item.slug ? { ...i, hasVoted: !item.hasVoted, voteCount: res.voteCount } : i)));
    } catch {
      load(); // out of sync with the server somehow (e.g. a race) — just refetch the truth
    } finally {
      setVoting((s) => {
        const next = new Set(s);
        next.delete(item.slug);
        return next;
      });
    }
  }

  function toggleEvidence(slug: string): void {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function submitRequest(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!signedIn) return goToLogin();
    setFormStatus("submitting");
    try {
      await apiFetch("/v1/integrations/requests", {
        method: "POST",
        body: JSON.stringify({ frameworkName: formName, frameworkUrl: formUrl.trim() || null, note: formNote.trim() || null }),
      });
      setFormStatus("done");
      setFormName("");
      setFormUrl("");
      setFormNote("");
    } catch {
      setFormStatus("error");
    }
  }

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Integrations</p>
        <h1 className={styles.title}>Which framework should OpenGlass support next?</h1>
        <p className={styles.lede}>
          OpenTelemetry and MCP already work today — see{" "}
          <a href="https://github.com/federico2001/OpenGlass/tree/main/otel-js">openglass-otel</a> and{" "}
          <a href="https://github.com/federico2001/OpenGlass/tree/main/apps/mcp">apps/mcp</a>. Vote for what's missing,
          or request a framework you don&apos;t see below.
        </p>
      </section>

      {loading ? (
        <p className={styles.empty}>Loading…</p>
      ) : (
        <div className={styles.grid}>
          {items.map((item) => (
            <div key={item.slug} className={styles.card}>
              <div className={styles.cardTop}>
                <p className={styles.name}>{item.name}</p>
                <span className={`${styles.statusBadge} ${styles[`status_${item.status}`] ?? ""}`}>{INTEGRATION_STATUS_LABEL[item.status]}</span>
              </div>
              <p className={styles.desc}>{item.description}</p>
              <div className={styles.cardFooter}>
                <button type="button" className={styles.voteButton} disabled={voting.has(item.slug)} onClick={() => toggleVote(item)}>
                  {item.hasVoted ? "★ Voted" : "☆ Vote"} · {item.voteCount}
                </button>
                <a href={item.url} target="_blank" rel="noreferrer" className={styles.link}>
                  Website
                </a>
                {item.evidence.length > 0 && (
                  <button type="button" className={styles.evidenceToggle} onClick={() => toggleEvidence(item.slug)}>
                    {expanded.has(item.slug) ? "Hide evidence" : "Evidence"}
                  </button>
                )}
              </div>
              {expanded.has(item.slug) && (
                <ul className={styles.evidenceList}>
                  {item.evidence.map((ev) => (
                    <li key={ev.url}>
                      <a href={ev.url} target="_blank" rel="noreferrer">
                        {ev.label}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <section className={styles.requestSection}>
        <h2 className={styles.requestTitle}>Don&apos;t see your framework?</h2>
        {formStatus === "done" ? (
          <p className={styles.empty}>Thanks — we&apos;ll take a look.</p>
        ) : (
          <form className={styles.requestForm} onSubmit={submitRequest}>
            <input
              required
              placeholder="Framework name"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className={styles.input}
            />
            <input placeholder="Website (optional)" value={formUrl} onChange={(e) => setFormUrl(e.target.value)} className={styles.input} />
            <textarea
              placeholder="Why do you want this? (optional)"
              value={formNote}
              onChange={(e) => setFormNote(e.target.value)}
              className={styles.textarea}
            />
            <button type="submit" className={styles.submitButton} disabled={formStatus === "submitting"}>
              {signedIn ? "Submit request" : "Sign in to submit"}
            </button>
            {formStatus === "error" && <p className={styles.errorText}>Something went wrong — try again.</p>}
          </form>
        )}
      </section>
    </main>
  );
}
