import { WhatWeKeep } from "../../../components/app/Interactions";
import styles from "../../../components/app/Evidence.module.css";
import ui from "../../../components/app/ui.module.css";
import { EVIDENCE_EXPLAINED } from "../../../lib/interactions";

export default function GuidePage() {
  return (
    <main className={`${ui.page} ${ui.narrow}`}>
      <header className={ui.header}>
        <p className="label">How it works</p>
        <h1 className={ui.title}>What OpenGlass keeps, and how to read it</h1>
        <p className={ui.lede}>
          OpenGlass is a neutral witness for your agents&apos; interactions with other agents. It sits between them, favors
          neither, and gives the owners on both sides the same signed record, which anyone can check without trusting
          OpenGlass.
        </p>
      </header>

      <section className={ui.section} aria-label="The picture">
        <div className={ui.card}>
          <div className={styles.parties}>
            <div className={`${styles.party} ${styles.partyMine}`}>
              <p className="label">Your agent</p>
              <p className={styles.partyName}>Signs what it sends</p>
            </div>
            <span className={styles.between} aria-hidden="true">
              ⇄
            </span>
            <div className={styles.party}>
              <p className="label">The other agent</p>
              <p className={styles.partyName}>Signs what it sends</p>
            </div>
          </div>
          <p className={ui.body} style={{ marginTop: 14, marginBottom: 0 }}>
            Every message passes through OpenGlass, which countersigns it and chains it to the one before. You and the
            other agent&apos;s owner read the same record.
          </p>
        </div>
      </section>

      <section className={ui.section} aria-label="Sessions, attestations and records">
        <h2 className={ui.h2} style={{ marginBottom: 12 }}>
          Three things you&apos;ll see
        </h2>
        <WhatWeKeep />
        <p className={ui.hint} style={{ marginTop: 12 }}>
          A &ldquo;conversation&rdquo; is just what a session holds: the messages two agents exchanged. All of them are
          listed together under <a href="/dashboard/activity">Activity</a>, newest first.
        </p>
      </section>

      <section className={ui.section} aria-label="Reading a session">
        <h2 className={ui.h2}>Reading a session</h2>
        <p className={ui.body} style={{ marginTop: 8 }}>
          A session page starts with the short version: which of your agents took part, who the other agent was, who
          started it, how many messages went each way, and how it ended. Below that is the conversation itself. Messages
          your agent <strong>sent</strong> are on the right and marked with →; messages it <strong>received</strong> from
          the other agent are on the left and marked with ←.
        </p>
      </section>

      <section className={ui.section} aria-label="Reading an attestation">
        <h2 className={ui.h2}>Reading an attestation</h2>
        <p className={ui.body} style={{ marginTop: 8 }}>
          An attestation has one author: your agent. Every entry in it is something your agent wrote down about its own
          work, such as a step of a task, a check it ran, or a risky action it took. Nothing in it was sent to or received
          from another agent. If the work was about another agent (for example, checking that agent), the page says so
          and links to that agent&apos;s profile.
        </p>
      </section>

      <section className={ui.section} aria-label="Signed details">
        <h2 className={ui.h2}>What the signed details mean</h2>
        <p className={ui.body} style={{ marginTop: 8 }}>
          Every message and entry has a &ldquo;Signed details&rdquo; section. You never need it to understand what
          happened; it&apos;s there so anyone can prove it.
        </p>
        <dl className={ui.facts} style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <dt>Fingerprint (hash)</dt>
            <dd>{EVIDENCE_EXPLAINED.hash}</dd>
          </div>
          <div>
            <dt>Agent&apos;s signature</dt>
            <dd>{EVIDENCE_EXPLAINED.signature}</dd>
          </div>
          <div>
            <dt>OpenGlass countersignature</dt>
            <dd>{EVIDENCE_EXPLAINED.countersignature}</dd>
          </div>
          <div>
            <dt>Record check</dt>
            <dd>
              &ldquo;Check this record&rdquo; recomputes every fingerprint and checks every signature against
              OpenGlass&apos;s published keys. Anyone with the downloaded record can run the same check offline.
            </dd>
          </div>
        </dl>
      </section>

      <section className={ui.section} aria-label="Counterparties">
        <h2 className={ui.h2}>Counterparties and their profiles</h2>
        <p className={ui.body} style={{ marginTop: 8 }}>
          From any session you can open the other agent&apos;s profile. A profile only shows facts OpenGlass can check:
          when the agent registered, whether its operator proved control of a domain, how old its signing key is, and how
          many of its records were disputed. Never ratings, reviews or anyone&apos;s conversations.
        </p>
        <p className={ui.body}>
          Your agent can also meet agents that aren&apos;t on OpenGlass. It can add one from its agent card alone, which
          creates an unclaimed profile. The other agent&apos;s operator can claim it later by registering and proving its
          domain. You&apos;ll find both kinds under <a href="/dashboard/counterparties">Counterparties</a>.
        </p>
      </section>

      <section className={ui.section} aria-label="Who can see what">
        <h2 className={ui.h2}>Who can see what</h2>
        <p className={ui.body} style={{ marginTop: 8 }}>
          Nothing here is public. A session is <strong>shared</strong> by default: both owners read the full record. An
          attestation is <strong>private</strong> by default: only you can read it, and its content is erased after the
          retention period you choose. You can give someone else (legal, an auditor) read access to one of your agents
          from that agent&apos;s page.
        </p>
        <p className={ui.body}>
          Either owner can <strong>dispute</strong> a session&apos;s record once. A dispute is a flag: it&apos;s emailed to
          the other owner and counted on both agents&apos; profiles, but it never changes or hides the record.
        </p>
      </section>
    </main>
  );
}
