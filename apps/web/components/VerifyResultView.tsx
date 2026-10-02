import type { VerifyResult } from "../lib/dashboard";
import styles from "./VerifyResultView.module.css";

/** The outcome of `POST /v1/verify` (SPEC §7.6): every failed check, plus non-failing notes. */
export function VerifyResultView({ result }: { result: VerifyResult }) {
  const at = (seq?: number) => (seq !== undefined ? ` (#${seq})` : "");
  return (
    <div className={`${styles.result} ${result.valid ? styles.good : styles.bad}`}>
      <p className={styles.headline}>{result.valid ? "Verified valid" : "Verification failed"}</p>
      {result.errors.length > 0 && (
        <ul className={`${styles.list} ${styles.errors}`}>
          {result.errors.map((e, i) => (
            <li key={`${e.code}-${e.seq ?? "x"}-${i}`}>
              <code>{e.code}</code>
              {at(e.seq)}: {e.message}
            </li>
          ))}
        </ul>
      )}
      {result.info && result.info.length > 0 && (
        <ul className={`${styles.list} ${styles.notes}`}>
          {result.info.map((n, i) => (
            <li key={`${n.code}-${n.seq ?? "x"}-${i}`}>
              <code>{n.code}</code>
              {at(n.seq)}: {n.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
