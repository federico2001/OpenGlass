import { TwinPane } from "./TwinPane";
import styles from "./WitnessDiagram.module.css";

/**
 * The landing page's one-glance explanation: OpenGlass is a thin witness layer on each agent,
 * signing every message as it passes and taking neither side, and both owners end up holding the
 * same locked record.
 * Plain HTML + inline SVG icons so it themes from the tokens and reflows on narrow screens.
 */

const RECORD = [
  { from: "A", what: "engagement" },
  { from: "B", what: "proposal" },
  { from: "A", what: "agreement" },
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

function Agent({ name, note }: { name: string; note: string }) {
  return (
    <div className={styles.agent}>
      <AgentIcon />
      <span className={styles.name}>{name}</span>
      <span className={styles.note}>{note}</span>
    </div>
  );
}

/** The witness: a thin layer on the outside of each agent that every message passes through. */
function Layer() {
  return (
    <div className={styles.layer}>
      <TwinPane size={18} />
      <span className={styles.layerName}>OpenGlass</span>
    </div>
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
        <div className={styles.side}>
          <Agent name="Agent A" note="yours" />
          <Layer />
        </div>

        <div className={styles.wire} aria-hidden="true">
          <span className={`${styles.pulse} ${styles.toRight}`} />
          <span className={`${styles.pulse} ${styles.toLeft}`} />
        </div>

        <div className={styles.side}>
          <Layer />
          <Agent name="Agent B" note="theirs" />
        </div>
      </div>

      <div className={styles.branch} aria-hidden="true">
        <span />
        <span />
      </div>

      <div className={styles.records}>
        <Record owner="A's owner" />
        <span className={styles.same} aria-label="is the same record as">
          =
        </span>
        <Record owner="B's owner" />
      </div>

      <figcaption className={styles.caption}>
        OpenGlass signs every message on both sides and favors neither. Both owners hold the same record,
        and nobody can change it, OpenGlass included.
      </figcaption>
    </figure>
  );
}
