import { TwinPane } from "./TwinPane";
import styles from "./WitnessDiagram.module.css";

/**
 * The landing page's one-glance explanation: two agents talk through OpenGlass, which signs
 * every message and takes neither side, and both owners end up holding the same locked record.
 * Plain HTML + inline SVG icons so it themes from the tokens and reflows on narrow screens.
 */

const RECORD = [
  { from: "A", what: "offer" },
  { from: "B", what: "counter" },
  { from: "A", what: "accept" },
];

function AgentIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 7V4M9.5 12.5v1M14.5 12.5v1" />
    </svg>
  );
}

function OwnerIcon() {
  return (
    <svg className={styles.iconSmall} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className={styles.lock} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function Record({ owner }: { owner: string }) {
  return (
    <div className={styles.record}>
      <p className={styles.recordHead}>
        <OwnerIcon />
        {owner}
      </p>
      <ol className={styles.lines}>
        {RECORD.map((m) => (
          <li key={m.what}>
            <span className={styles.from}>{m.from}</span>
            <span className={styles.what}>{m.what}</span>
            <span className={styles.check} aria-label="signed">
              ✓
            </span>
          </li>
        ))}
      </ol>
      <p className={styles.seal}>
        <LockIcon />
        <span>9f3c…e1a0</span>
      </p>
    </div>
  );
}

export function WitnessDiagram() {
  return (
    <figure className={styles.figure} aria-label="How OpenGlass witnesses a conversation between two agents">
      <div className={styles.talk}>
        <div className={styles.agent}>
          <AgentIcon />
          <span className={styles.name}>Agent A</span>
          <span className={styles.note}>yours</span>
        </div>

        <div className={styles.wire} aria-hidden="true">
          <span className={styles.chip}>offer</span>
          <span className={`${styles.pulse} ${styles.toRight}`} />
        </div>

        <div className={styles.witness}>
          <TwinPane size={40} />
          <span className={styles.name}>OpenGlass</span>
          <span className={styles.note}>signs every message</span>
          <span className={styles.note}>favors neither</span>
        </div>

        <div className={styles.wire} aria-hidden="true">
          <span className={styles.chip}>counter</span>
          <span className={`${styles.pulse} ${styles.toLeft}`} />
        </div>

        <div className={styles.agent}>
          <AgentIcon />
          <span className={styles.name}>Agent B</span>
          <span className={styles.note}>theirs</span>
        </div>
      </div>

      <div className={styles.branch} aria-hidden="true" />

      <div className={styles.records}>
        <Record owner="A's owner" />
        <span className={styles.same} aria-label="is the same record as">
          =
        </span>
        <Record owner="B's owner" />
      </div>

      <figcaption className={styles.caption}>
        Both owners hold the same record. Nobody can change it, OpenGlass included.
      </figcaption>
    </figure>
  );
}
