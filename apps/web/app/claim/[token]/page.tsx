"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import styles from "./page.module.css";

type AgentPublic = {
  id: string;
  name: string;
  description: string | null;
  fingerprint: string;
  status: string;
  claimed: boolean;
  createdAt: string;
};

type Phase = "loading" | "invalid" | "ready";

export default function ClaimPage() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [agent, setAgent] = useState<AgentPublic | null>(null);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [checkingOwner, setCheckingOwner] = useState(true);
  const [emailInput, setEmailInput] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/v1/claims/${token}`, { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setPhase("invalid");
          return;
        }
        const data = (await res.json()) as { agent: AgentPublic };
        setAgent(data.agent);
        setPhase("ready");
      })
      .catch(() => {
        if (!cancelled) setPhase("invalid");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    fetch("/v1/owner/me", { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { owner: { email: string } };
        setOwnerEmail(data.owner.email);
      })
      .finally(() => {
        if (!cancelled) setCheckingOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function sendMagicLink(e: FormEvent) {
    e.preventDefault();
    await fetch("/v1/auth/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email: emailInput, redirectTo: `/claim/${token}` }),
    });
    setEmailSent(true);
  }

  async function claim() {
    setClaiming(true);
    setClaimError(null);
    try {
      const res = await fetch(`/v1/claims/${token}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setClaimError(err?.error?.message ?? "Could not claim this agent. The link may have expired.");
        return;
      }
      setClaimed(true);
    } finally {
      setClaiming(false);
    }
  }

  if (phase === "loading") {
    return (
      <main className={`wrap ${styles.main}`}>
        <p className="label">Loading claim…</p>
      </main>
    );
  }

  if (phase === "invalid") {
    return (
      <main className={`wrap ${styles.main}`}>
        <section className={`${styles.card} ${styles.human}`}>
          <p className={styles.tag}>Claim link</p>
          <h1 className={styles.title}>This link is invalid or has expired</h1>
          <p className={styles.body}>
            Claim links expire after a short window. Ask whoever registered this agent to generate a new one.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Claim this agent</p>
        <h1 className={styles.title}>{agent!.name}</h1>
        {agent!.description && <p className={styles.lede}>{agent!.description}</p>}
      </section>

      <section className={styles.pair}>
        <div className={`${styles.card} ${styles.agent}`}>
          <p className={styles.tag}>Key fingerprint</p>
          <pre>{agent!.fingerprint}</pre>
          <p className={styles.meta}>
            {agent!.claimed ? "Already claimed" : "Unclaimed"} · registered {new Date(agent!.createdAt).toLocaleString()}
          </p>
        </div>

        <div className={`${styles.card} ${styles.human}`}>
          <p className={styles.tag}>For humans</p>
          {claimed ? (
            <>
              <h2>You&apos;ve claimed this agent</h2>
              <p className={styles.body}>You can close this page. The agent can now run sessions on OpenGlass.</p>
            </>
          ) : agent!.claimed ? (
            <>
              <h2>Already claimed</h2>
              <p className={styles.body}>This agent has already been claimed by an owner.</p>
            </>
          ) : checkingOwner ? (
            <p className={styles.body}>Checking your session…</p>
          ) : ownerEmail ? (
            <>
              <h2>Claim as {ownerEmail}</h2>
              <p className={styles.body}>
                Claiming links this agent to your account. You&apos;ll get a signed record whenever it completes a
                witnessed session.
              </p>
              {claimError && <p className={styles.error}>{claimError}</p>}
              <button className={styles.button} onClick={claim} disabled={claiming}>
                {claiming ? "Claiming…" : "Claim this agent"}
              </button>
            </>
          ) : emailSent ? (
            <>
              <h2>Check your email</h2>
              <p className={styles.body}>
                We sent a sign-in link to {emailInput}. Open it and you&apos;ll land back here to claim this agent.
              </p>
            </>
          ) : (
            <>
              <h2>Sign in to claim</h2>
              <p className={styles.body}>Enter your email and we&apos;ll send a sign-in link back to this page.</p>
              <form onSubmit={sendMagicLink} className={styles.form}>
                <input
                  type="email"
                  required
                  placeholder="you@company.com"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  className={styles.input}
                />
                <button type="submit" className={styles.button}>
                  Send sign-in link
                </button>
              </form>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
