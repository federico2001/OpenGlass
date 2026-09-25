import { STATUS_LABEL } from "../lib/dashboard";
import styles from "./StatusBadge.module.css";

const GOOD = new Set(["active", "closed"]);
const BAD = new Set(["suspended", "declined", "cancelled", "expired", "revoked"]);

export function StatusBadge({ status }: { status: string }) {
  const tone = GOOD.has(status) ? styles.good : BAD.has(status) ? styles.bad : "";
  return (
    <span className={`${styles.badge} ${tone}`}>
      <span className={styles.dot} aria-hidden="true" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
