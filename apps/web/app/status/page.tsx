"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";

const POLL_MS = 30_000;

type State = "checking" | "ok" | "fail";

interface Check {
  key: string;
  name: string;
  what: string;
}

const CHECKS: Check[] = [
  { key: "api", name: "API", what: "Registration, sessions, messages and records (/v1)." },
  { key: "mongo", name: "Database", what: "Where sessions, messages and records are kept." },
  { key: "s3", name: "Evidence storage", what: "The Object Lock bucket that holds issued record bundles." },
  { key: "keys", name: "Platform keys", what: "The public keys anyone verifies records against." },
];

const LABEL: Record<State, string> = { checking: "Checking", ok: "Operational", fail: "Down" };

async function runChecks(): Promise<Record<string, State>> {
  const out: Record<string, State> = {};
  try {
    const res = await fetch("/health", { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as { checks?: Record<string, string> } | null;
    out.api = res.status === 200 || res.status === 503 ? "ok" : "fail";
    for (const name of ["mongo", "s3"]) out[name] = body?.checks?.[name] === "ok" ? "ok" : "fail";
  } catch {
    out.api = out.mongo = out.s3 = "fail";
  }
  try {
    const res = await fetch("/.well-known/openglass-keys.json", { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as { keys?: unknown[] } | null;
    out.keys = res.ok && Array.isArray(body?.keys) && body.keys.length > 0 ? "ok" : "fail";
  } catch {
    out.keys = "fail";
  }
  return out;
}

export default function StatusPage() {
  const [states, setStates] = useState<Record<string, State>>({});
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const result = await runChecks();
      if (cancelled) return;
      setStates(result);
      setCheckedAt(new Date());
    }
    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const allOk = checkedAt !== null && CHECKS.every((c) => states[c.key] === "ok");

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Status</p>
        <h1 className={styles.title}>{checkedAt === null ? "Checking…" : allOk ? "All systems operational" : "Something is down"}</h1>
        <p className={styles.lede}>
          Live checks from your browser against the running service, refreshed every 30 seconds. There is no uptime
          SLA.
        </p>
      </section>

      <ul className={styles.list}>
        {CHECKS.map((c) => {
          const state = states[c.key] ?? "checking";
          return (
            <li key={c.key} className={styles.row}>
              <div>
                <p className={styles.name}>{c.name}</p>
                <p className={styles.what}>{c.what}</p>
              </div>
              <span className={`${styles.state} ${styles[state]}`}>{LABEL[state]}</span>
            </li>
          );
        })}
      </ul>

      <p className={styles.checked}>{checkedAt ? `Last checked ${checkedAt.toISOString()}` : " "}</p>

      <p className={styles.note}>
        If OpenGlass is down, new sessions and attestations can&apos;t start. Records already issued stay verifiable,
        because verification runs offline against the published platform keys and never calls back to OpenGlass.
      </p>
    </main>
  );
}
