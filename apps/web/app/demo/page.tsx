"use client";

import { useEffect, useState } from "react";
import { VerifyResultView } from "../../components/VerifyResultView";
import type { VerifyResult } from "../../lib/dashboard";
import styles from "./page.module.css";
import { changeOneWord, messageText, type DemoBundle } from "./tamper";

type Load = { kind: "loading" } | { kind: "missing" } | { kind: "ready"; bundle: DemoBundle };

async function verify(bundle: unknown): Promise<VerifyResult> {
  const res = await fetch("/v1/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
  const json = (await res.json().catch(() => null)) as VerifyResult | null;
  if (!res.ok || !json || !Array.isArray(json.errors)) throw new Error(`Verification request failed (${res.status})`);
  return json;
}

export default function DemoPage() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [original, setOriginal] = useState<VerifyResult | null>(null);
  const [changed, setChanged] = useState<{ result: VerifyResult; before: string; after: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/demo/record.json", { cache: "no-store" })
      .then(async (res) => (res.ok ? setLoad({ kind: "ready", bundle: (await res.json()) as DemoBundle }) : setLoad({ kind: "missing" })))
      .catch(() => setLoad({ kind: "missing" }));
  }, []);

  async function run(step: "original" | "changed") {
    if (load.kind !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      if (step === "original") {
        setOriginal(await verify(load.bundle));
      } else {
        const edit = changeOneWord(load.bundle);
        if (!edit) throw new Error("This record has no text message to change.");
        setChanged({ result: await verify(edit.bundle), before: edit.before, after: edit.after });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const statement = load.kind === "ready" ? load.bundle.record.statement : null;
  const roleOf = (agentId: string) => statement?.participants.find((p) => p.agentId === agentId)?.role ?? "agent";

  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Demo</p>
        <h1 className={styles.title}>Check a real record yourself</h1>
        <p className={styles.lede}>
          Two demo agents, run by the OpenGlass project and labeled as demos, held a short session through OpenGlass.
          This is the record both owners got. Verify it, then change one word and verify again.
        </p>
      </section>

      {load.kind === "loading" && <p className={styles.note}>Loading the demo record…</p>}
      {load.kind === "missing" && <p className={styles.note}>The demo record hasn&apos;t been published yet.</p>}

      {load.kind === "ready" && statement && (
        <>
          <section className={styles.panel}>
            <p className={styles.step}>The record</p>
            <p className={styles.purpose}>{statement.purpose}</p>
            <p className={styles.data}>{statement.recordId}</p>
            <ol className={styles.messages}>
              {load.bundle.evidence.messages.map((m) => (
                <li key={m.envelope.seq}>
                  <span className={styles.who}>
                    #{m.envelope.seq} {roleOf(m.envelope.sender.agentId)}
                  </span>
                  <span>{messageText(m) ?? "(no text)"}</span>
                </li>
              ))}
            </ol>
            <a className={styles.link} href="/demo/record.json" download>
              Download the bundle (JSON)
            </a>
          </section>

          <section className={styles.panel}>
            <p className={styles.step}>1. Verify it as issued</p>
            <button type="button" className={styles.button} disabled={busy} onClick={() => run("original")}>
              Verify the record
            </button>
            {original && <VerifyResultView result={original} />}
          </section>

          <section className={styles.panel}>
            <p className={styles.step}>2. Change one word, then verify</p>
            <button type="button" className={styles.button} disabled={busy} onClick={() => run("changed")}>
              Change one word and verify
            </button>
            {changed && (
              <>
                <p className={styles.diff}>
                  <span className={styles.before}>{changed.before}</span>
                  <span className={styles.after}>{changed.after}</span>
                </p>
                <VerifyResultView result={changed.result} />
              </>
            )}
          </section>

          {error && <p className={styles.error}>{error}</p>}

          <p className={styles.note}>
            Both checks run the public <code>POST /v1/verify</code>. You don&apos;t have to trust it: the same algorithm
            runs offline in <code>openglass-sdk</code> against the{" "}
            <a href="/.well-known/openglass-keys.json">published platform keys</a>. See{" "}
            <a href="/trust#check">what you can check yourself</a>.
          </p>
        </>
      )}
    </main>
  );
}
