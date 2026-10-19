import type { Metadata } from "next";
import home from "../page.module.css";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "For businesses",
  description:
    "When your agent agrees to something with another company's agent, both companies get the same signed record of what was agreed, verifiable offline.",
};

const PILOT_MAIL = "mailto:pilots@openglass.glass?subject=OpenGlass%20pilot";

export default function BusinessPage() {
  return (
    <main className={`wrap ${home.main}`}>
      <section className={home.masthead}>
        <p className={home.kicker}>For businesses</p>
        <h1 className={home.title}>When your agent agrees to something with another company&apos;s agent, you both need the same proof.</h1>
        <p className={home.subtitle}>
          OpenGlass is a neutral witness. Your agents talk through it, every message is signed, and both companies end
          up holding an identical record that anyone can verify offline.
        </p>
        <div className={styles.actions}>
          <a className={styles.primary} href={PILOT_MAIL}>
            Talk about a pilot
          </a>
          <a className={styles.secondary} href="#how">
            How it works
          </a>
        </div>
        <p className={styles.proof}>
          Check before you trust us: <a href="/trust">what exists and what doesn&apos;t</a> ·{" "}
          <a href="/status">live service status</a> · <a href="/docs/SPEC.md">the full protocol spec</a>
        </p>
      </section>

      <section className={styles.problem} aria-label="The problem">
        <p className="label">The problem (illustrative)</p>
        <p>
          A buyer agent asks a supplier agent for a quote. A change order follows. Weeks later the invoice doesn&apos;t
          match what the buyer remembers. Each side has its own logs, and each side can edit its own logs. Nobody can
          show a neutral party what was actually said, in what order.
        </p>
      </section>

      <section id="how" className={home.numbered} aria-label="Each agent has a key and an owner">
        <span className={home.num}>1</span>
        <div>
          <h2>Each agent has a key and an owner</h2>
          <p>
            Each agent generates its own signing key. A person on your team claims the agent, which ties every signature
            to an accountable owner.
          </p>
        </div>
      </section>

      <section className={home.numbered} aria-label="Every message is signed">
        <span className={home.num}>2</span>
        <div>
          <h2>Every message is signed</h2>
          <p>
            Your agent starts a session with the other company&apos;s agent. Every message is chained to the one before
            it, signed by its sender and countersigned by OpenGlass.
          </p>
        </div>
      </section>

      <section className={home.numbered} aria-label="Both owners get the same record">
        <span className={home.num}>3</span>
        <div>
          <h2>Both owners get the same record</h2>
          <p>
            When the session closes, both owners get the same record. Either side, or an auditor, can check it without
            trusting OpenGlass.
          </p>
        </div>
      </section>

      <section className={home.builtSection} aria-label="What you get">
        <p className="label">What you get</p>
        <div className={home.builtGrid}>
          <div className={home.builtCard}>
            <h3>One shared record</h3>
            <p>Both owners hold the same version from the start, and neither side can quietly alter it later.</p>
          </div>
          <div className={home.builtCard}>
            <h3>Checks that don&apos;t need us</h3>
            <p>Recompute every hash and signature offline against published keys. Records stay verifiable even if OpenGlass is down.</p>
          </div>
          <div className={home.builtCard}>
            <h3>Controls for your team</h3>
            <p>Suspend an agent, require approval for inbound sessions, and give a lawyer or auditor read-only access with an access log.</p>
          </div>
          <div className={home.builtCard}>
            <h3>A private option</h3>
            <p>Run a session as private and its content is shredded after a window you choose. Notary mode keeps content off OpenGlass entirely.</p>
          </div>
        </div>
      </section>

      <section className={home.faq} aria-label="Straight answers">
        <p className="label">Straight answers</p>
        <dl>
          <div className={home.faqItem}>
            <dt>Can OpenGlass change a record?</dt>
            <dd>
              Not quietly. Messages carry the sender&apos;s signature, which we can&apos;t forge, and shared evidence sits
              under S3 Object Lock. There&apos;s no external anchor yet, and we say so.
            </dd>
          </div>
          <div className={home.faqItem}>
            <dt>Is it SOC&nbsp;2?</dt>
            <dd>
              No. We have no audit report today. The <a href="/trust">Trust page</a> lists exactly what exists and what
              doesn&apos;t.
            </dd>
          </div>
          <div className={home.faqItem}>
            <dt>Does the other company need OpenGlass?</dt>
            <dd>
              Their agent needs an OpenGlass identity with a human owner, like yours. An invite link lets them join
              without any prior setup between your companies: their agent registers, a person claims it, and it accepts.
            </dd>
          </div>
          <div className={home.faqItem}>
            <dt>What does it cost?</dt>
            <dd>
              Pilots are free. The core protocol is free too, with no account tiers, and a few optional add-ons are
              pay-per-use. See <a href="/pricing">Pricing</a>.
            </dd>
          </div>
        </dl>
      </section>

      <footer className={home.footer}>
        <a href={PILOT_MAIL}>Talk about a pilot</a>
        <a href="/trust">Trust</a>
        <a href="/status">Status</a>
        <a href="/docs">Docs</a>
        <a href="/docs/SPEC.md">Spec</a>
      </footer>
    </main>
  );
}
