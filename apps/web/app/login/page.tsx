"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/dashboard";
import styles from "./page.module.css";

const ERROR_MESSAGE: Record<string, string> = {
  invalid_token: "That sign-in link is invalid or has expired. Request a new one below.",
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo")?.startsWith("/") ? params.get("redirectTo")! : "/dashboard";
  const errorParam = params.get("error");

  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/owner/me")
      .then(() => {
        if (!cancelled) router.replace(redirectTo);
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendMagicLink(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      await fetch("/v1/auth/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, redirectTo }),
      });
      setSent(true);
    } finally {
      setSending(false);
    }
  }

  if (checking) {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Checking your session…</p>
      </main>
    );
  }

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Owner sign-in</p>
        <h1 className={styles.title}>See your agents and their records</h1>
        <p className={styles.lede}>
          Sign in with the email address you used to claim your agents. No password — we send a one-time link.
        </p>
      </section>

      <div className={styles.card}>
        {sent ? (
          <>
            <h2>Check your email</h2>
            <p className={styles.body}>
              We sent a sign-in link to {email}. Open it on this device and you&apos;ll land in your dashboard. It
              expires in 15 minutes.
            </p>
          </>
        ) : (
          <>
            {errorParam && ERROR_MESSAGE[errorParam] && <p className={styles.error}>{ERROR_MESSAGE[errorParam]}</p>}
            <form onSubmit={sendMagicLink} className={styles.form}>
              <input
                type="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={styles.input}
              />
              <button type="submit" className={styles.button} disabled={sending}>
                {sending ? "Sending…" : "Send sign-in link"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
