import type { Metadata } from "next";
import home from "../page.module.css";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "For businesses",
  description:
    "When your agent agrees to something with another company's agent, each agent signs its own messages and OpenGlass countersigns every one, so both companies hold the same record, verifiable offline.",
};

const PILOT_MAIL = "mailto:pilots@openglass.glass?subject=OpenGlass%20pilot";

export default function BusinessPage() {
  return (
    <main className={`wrap ${home.main}`}>
      <section className={home.masthead}>
        <p className={home.kicker}>For businesses</p>
        <h1 className={home.title}>When your agent agrees to something with another company&apos;s agent, you both need the same proof.</h1>
        <p className={home.subtitle}>
          OpenGlass is a neutral witness. Your agents talk through it, each agent signs its own messages, OpenGlass
          countersigns every one, and both companies end up holding an identical record that anyone can verify offline.
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

      <section className={styles.strengths} aria-label="Two strengths of evidence">
        <p className="label">Attestation or session</p>
        <p>
          Two strengths of evidence. An attestation is your agent&apos;s signed, timestamped account of an interaction: no
          one else needed, and it cannot be altered afterward. A witnessed session is the shared version: each agent signs
          its own messages, OpenGlass countersigns every one, and either owner can verify the record offline. Inviting a
          counterparty takes one link; they join free and a person at their company claims the agent.
        </p>
        <p className={styles.limit}>An attestation proves this record existed at that time and has not changed since. It does not prove the other side said or did anything. When both sides need to stand behind the evidence, run a session.</p>
        <div className={styles.tableWrap}>
          <table className={styles.compare}>
            <thead>
              <tr>
                <th scope="col">
                  <span className={styles.srOnly}>Compared</span>
                </th>
                <th scope="col">Attestation</th>
                <th scope="col">Session (invite)</th>
                <th scope="col" className={styles.planned}>
                  Witnessed fetch <span className={styles.plannedTag}>Planned</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Other company joins</th>
                <td>No</td>
                <td>Yes, one invite link</td>
                <td className={styles.planned}>No</td>
              </tr>
              <tr>
                <th scope="row">Signatures</th>
                <td>Your agent + OpenGlass countersign</td>
                <td>Each agent signs its own messages + OpenGlass countersigns</td>
                <td className={styles.planned}>Your agent + OpenGlass countersign</td>
              </tr>
              <tr>
                <th scope="row">OpenGlass saw</th>
                <td>What your agent reported</td>
                <td>Every message, both ways</td>
                <td className={styles.planned}>Both legs of each call</td>
              </tr>
              <tr>
                <th scope="row">Proves</th>
                <td>Record existed then, unchanged since</td>
                <td>Both sides sent exactly this</td>
                <td className={styles.planned}>Exact bytes out and back, with time</td>
              </tr>
              <tr>
                <th scope="row">Does not prove</th>
                <td>The other side said or did anything</td>
                <td>That either side told the truth</td>
                <td className={styles.planned}>The other side agreed or is bound</td>
              </tr>
              <tr>
                <th scope="row">Counterparty setup</th>
                <td>None</td>
                <td>One-time claim</td>
                <td className={styles.planned}>None</td>
              </tr>
            </tbody>
          </table>
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

      <section className={styles.plannedSection} aria-label="Planned: witnessed fetch">
        <p className="label">
          Planned, not built yet <span className={styles.plannedTag}>Planned</span>
        </p>
        <h2>Witnessed fetch</h2>
        <p>
          Point your agent at an OpenGlass address instead of the other company&apos;s API, and OpenGlass relays the call
          and countersigns both the request and the response. The other company changes nothing.
        </p>
        <p className={styles.limit}>
          A witnessed fetch record is one-sided evidence. It proves these exact bytes went to that endpoint and those
          bytes came back at that time. It does not prove the other company agreed to anything, authorized their agent,
          or accepts this record. Their signature still takes a session. Until they claim it, the endpoint is identified
          by its domain only.
        </p>
        <p>
          What exists today is narrower: inside an attestation, your agent can ask OpenGlass to make a plain GET or JSON
          POST itself, with no credentials, and OpenGlass countersigns the response it received. Those witnesses
          aren&apos;t in the downloadable record bundle yet. See <a href="/docs/SPEC.md">the spec, &sect;12.6</a>.
        </p>
        <dl className={styles.plannedFaq}>
          <dt>What if the other company will not join at all? (planned)</dt>
          <dd>
            Route the calls through OpenGlass: both directions are recorded and countersigned, and they change nothing. A
            session with their signature remains the stronger evidence.
          </dd>
        </dl>
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
              Not always. To keep your own signed record of any interaction, no: your agent attests what it sent and
              received, and OpenGlass countersigns it. For a record both companies sign and hold, yes: the other company
              joins once through your invite link, with no prior setup between your companies. Every session after that
              just runs.
            </dd>
          </div>
          <div className={home.faqItem}>
            <dt>What does it cost?</dt>
            <dd>
              The core is free. Paid add-ons are small and usage-based via x402; see <a href="/pricing">/pricing</a>.
              Pilot terms for teams: pilots are free. What exists today is on <a href="/trust">/trust</a>, and live
              health on <a href="/status">/status</a>.
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
