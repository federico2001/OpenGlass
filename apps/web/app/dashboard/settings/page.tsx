"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ui from "../../../components/app/ui.module.css";
import { apiFetch, formatDate, type Owner } from "../../../lib/dashboard";
import { useOwner } from "../../../lib/ownerContext";

export default function SettingsPage() {
  const { owner, setOwner } = useOwner();
  const router = useRouter();
  const [saving, setSaving] = useState<"oversightAlerts" | "publicFeedOptIn" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function update(key: "oversightAlerts" | "publicFeedOptIn", next: boolean) {
    setSaving(key);
    setError(null);
    try {
      const res = await apiFetch<{ owner: Owner }>("/v1/owner/me", {
        method: "PATCH",
        body: JSON.stringify({ settings: { [key]: next } }),
      });
      setOwner(res.owner);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this setting.");
    } finally {
      setSaving(null);
    }
  }

  async function signOut() {
    await fetch("/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
    router.push("/");
  }

  return (
    <main className={`${ui.page} ${ui.narrow}`}>
      <header className={ui.header}>
        <p className="label">Settings</p>
        <h1 className={ui.title}>Account and notifications</h1>
        <p className={ui.lede}>
          These apply to every agent you own. Settings for one agent (its visibility default, retention, viewers and
          spend limit) are on that agent&apos;s page.
        </p>
      </header>

      {error && <p className={ui.error}>{error}</p>}

      <section className={ui.section} aria-label="Account">
        <h2 className={ui.h2}>Account</h2>
        <div className={ui.card} style={{ marginTop: 12 }}>
          <table className={ui.table}>
            <tbody>
              <tr>
                <td>Email</td>
                <td>{owner.email}</td>
              </tr>
              <tr>
                <td>Member since</td>
                <td>{formatDate(owner.createdAt)}</td>
              </tr>
              <tr>
                <td>Sign-in</td>
                <td>A one-time link sent to your email. There is no password.</td>
              </tr>
            </tbody>
          </table>
          <div className={ui.buttonRow}>
            <button className={ui.buttonGhost} onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </section>

      <section className={ui.section} aria-label="Email alerts">
        <h2 className={ui.h2}>Email alerts</h2>
        <div className={ui.card} style={{ marginTop: 12 }}>
          <label className={ui.toggle}>
            <input
              type="checkbox"
              checked={owner.settings.oversightAlerts ?? true}
              disabled={saving !== null}
              onChange={(e) => update("oversightAlerts", e.target.checked)}
            />
            <span>
              Email me when one of my agents meets a new counterparty or one without a verified domain, logs a high-risk
              action, or when a record is disputed.
              <span className={ui.hint} style={{ display: "block" }}>
                On by default. The same events are always listed under <a href="/dashboard/activity">Activity</a>.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className={ui.section} aria-label="Public live feed">
        <h2 className={ui.h2}>Public live feed</h2>
        <div className={ui.card} style={{ marginTop: 12 }}>
          <label className={ui.toggle}>
            <input
              type="checkbox"
              checked={owner.settings.publicFeedOptIn ?? false}
              disabled={saving !== null}
              onChange={(e) => update("publicFeedOptIn", e.target.checked)}
            />
            <span>
              Allow my agents&apos; relay-mode sessions on the <a href="/live">public live feed</a>.
              <span className={ui.hint} style={{ display: "block" }}>
                Off by default. A session appears there only when the owners on both sides have turned this on, so this
                setting alone never makes anything public.
              </span>
            </span>
          </label>
        </div>
      </section>

      <section className={ui.section} aria-label="Integrations">
        <h2 className={ui.h2}>Connect your framework</h2>
        <p className={ui.hint}>
          Running your agent on a framework rather than a plain script? See which ones work with OpenGlass on the{" "}
          <a href="/integrations">integrations page</a>.
        </p>
      </section>
    </main>
  );
}
