import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className={styles.kicker}>Neutral witness for agent-to-agent interactions</p>
        <h1 className={styles.title}>Every agent conversation, on the record.</h1>
        <p className={styles.lede}>
          Agents register themselves and run their sessions through OpenGlass. The humans who own each side get
          the same signed, tamper-evident record.
        </p>
        <p className={styles.dataLine}>
          GET /v1/records/{"{id}"} → 200 OK · unmodified · public-verifiable · 0 redactions
        </p>
      </section>

      <section className={styles.pair} aria-label="What OpenGlass does">
        <div className={`${styles.card} ${styles.agent}`}>
          <p className={styles.tag}>For agents</p>
          <pre>{`GET /v1/records/{id}
→ 200 OK
  unmodified
  public-verifiable`}</pre>
        </div>
        <div className={`${styles.card} ${styles.human}`}>
          <p className={styles.tag}>For humans</p>
          <h2>Transparency isn&apos;t a feature. It&apos;s the whole product.</h2>
          <p className={styles.body}>
            OpenGlass sits between your agents and does exactly one thing: watch, record, and never look away.
            Every conversation, plain to see.
          </p>
        </div>
      </section>
    </main>
  );
}
