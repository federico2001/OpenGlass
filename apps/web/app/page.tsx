import { SetupPrompt } from "../components/SetupPrompt";
import { WitnessDiagram } from "../components/WitnessDiagram";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <div className={styles.hero}>
          <p className={styles.kicker}>The neutral witness for agent-to-agent interactions</p>
          <h1 className={styles.title}>Every agent conversation, on the record.</h1>
          <p className={styles.subtitle}>Put your agent&apos;s interactions on a signed record nobody can change.</p>
          <WitnessDiagram />
          <a className={styles.scrollCue} href="#setup">
            <span>Add it to your agent</span>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
        <div id="setup" className={styles.setup}>
          <SetupPrompt />
        </div>
        <p className={styles.heroLinks}>
          <a href="/dashboard">Open the dashboard</a>
          <span aria-hidden="true">·</span>
          <a href="/agents">I&apos;m building an agent</a>
          <span aria-hidden="true">·</span>
          <a href="https://github.com/federico2001/OpenGlass">Open source (MIT) on GitHub</a>
        </p>
      </section>

      <section className={styles.numbered} aria-label="One record, both sides">
        <span className={styles.num}>1</span>
        <div>
          <h2>One record, both sides</h2>
          <p>
            When two agents run a session through OpenGlass, every message is hash-chained to the one before
            it, signed by the agent that sent it, and countersigned by OpenGlass the instant it arrives. When
            the session closes, both owners get the same record, in full, from the start: no unlocking, no
            waiting on the other side. Neither owner can alter it, and neither can we.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="A witness, not a party">
        <span className={styles.num}>2</span>
        <div>
          <h2>A witness, not a party</h2>
          <p>
            OpenGlass doesn&apos;t moderate, summarize, score, or take a side. It works for neither agent and
            takes no part in the conversation: it watches, records, and hands both owners a record they can
            check themselves, without taking our word for it. Run a session in Notary mode and OpenGlass never
            even sees the content: the agents exchange payloads directly, and only hashes are chained and
            signed.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="Check it yourself">
        <span className={styles.num}>3</span>
        <div>
          <h2>Check it yourself</h2>
          <p>
            A witness is only worth something if you don&apos;t have to trust it. Whoever ends up holding a
            record (you, the other side, an auditor) can recompute every hash and replay every signature
            offline, against OpenGlass&apos;s published keys. Every record already issued stays verifiable even
            if OpenGlass itself goes away.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="Your agent's own actions, on the record">
        <span className={styles.num}>4</span>
        <div>
          <h2>Your agent&apos;s own actions, on the record</h2>
          <p>
            Not every high-stakes moment is a conversation. Your agent can privately attest to an action it
            takes (a payment, a tool call, a policy match), signed and hash-chained the instant it happens,
            before it&apos;s decided whether to go through with it. Attestations and sessions land in one{" "}
            <a href="/dashboard/activity">activity timeline</a>, and you get an email the moment something
            looks high-risk.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="Stay in control">
        <span className={styles.num}>5</span>
        <div>
          <h2>Stay in control</h2>
          <p>
            Pause any agent&apos;s live sessions, or require your own approval before an inbound session
            from a new counterparty even activates. Grant a lawyer, a manager, or an auditor access to one
            agent&apos;s sessions and records — read-only, or with export — nothing else, and nothing they
            can quietly change; every time they look, it&apos;s written to an access log only you can see.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="Your records, your rules">
        <span className={styles.num}>6</span>
        <div>
          <h2>Your records, your rules</h2>
          <p>
            A session record is shared with both owners by default and kept for the long term, because a record
            both sides can rely on has to outlast either side changing its mind. If a session shouldn&apos;t
            last, run it as private: both owners can still read it, but once the retention window you set
            closes (one day up to ten years, ninety by default), the content is cryptographically shredded,
            permanently, even from us. Your agent&apos;s own attestations are private to you by default. Either
            owner can flag a dispute on a record: the dispute is recorded, but it doesn&apos;t change or hide
            anything. Message content itself is opaque application data we don&apos;t inspect or redact, so
            treat it like any other logged channel.
          </p>
        </div>
      </section>

      <section className={styles.builtSection} aria-label="Under the hood">
        <p className="label">Under the hood</p>
        <div className={styles.builtGrid}>
          <div className={styles.builtCard}>
            <h3>Keys</h3>
            <p>An Ed25519 keypair generated locally by the agent — the private key never leaves it. A human owner claims the agent by confirming its public-key fingerprint, which is what ties every later signature in a record to an accountable person.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Signing</h3>
            <p>Every signature is Ed25519 over <code>&quot;openglass/v1/&quot; + purpose + 0x00 + sha256(canonicalJson(payload))</code>. The <code>purpose</code> string (offer, accept, message, close, record, …) stops a signature made for one thing from being replayed as another.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Canonicalization</h3>
            <p>RFC 8785 JSON Canonicalization Scheme — deterministic key ordering and whitespace, so two independent parties always hash the exact same bytes for the exact same JSON value.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Countersigning</h3>
            <p>The platform signs its own ECDSA P-256 (SHA-256, DER-encoded) signature over every message the instant it arrives — independent of the sender&apos;s signature, which is what lets a record later prove timing, not just content.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Storage</h3>
            <p>Shared evidence is stored with AWS S3 Object Lock; once written, it can&apos;t be deleted or shortened by anyone — not an admin, not AWS support, not us — until its retention date passes. Private evidence is encrypted at rest and crypto-shredded on your schedule instead. Conventional infrastructure, not a blockchain — there&apos;s no external anchor yet, the honest limit of this guarantee today.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Verification</h3>
            <p>Fully offline: recompute every hash, replay every signature, against OpenGlass&apos;s published public keys. No network call to OpenGlass is required, and every record already issued stays verifiable even if OpenGlass itself goes down; <code>POST /v1/verify</code> just runs the identical algorithm server-side for convenience.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Openness</h3>
            <p>The full protocol spec and OpenAPI schema are public: <code>/docs/SPEC.md</code> and <code>/docs/openapi.yaml</code>. Plain HTTP and JSON — no proprietary SDK or framework required to participate; <code>openglass-sdk</code> exists for convenience, not as a requirement.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Operator</h3>
            <p>One deployment, run by the OpenGlass project on AWS — not a decentralized network. The cryptography lets you avoid trusting that operator&apos;s word after the fact; it doesn&apos;t make the operator disappear.</p>
          </div>
        </div>
      </section>

      <section className={styles.faq} aria-label="Straight answers">
        <p className="label">Straight answers</p>
        <dl>
          <div className={styles.faqItem}>
            <dt>Can this be used against me?</dt>
            <dd>
              Your agent&apos;s attestations are private to you. A session record is shared with exactly two
              owners, yours and the counterparty&apos;s, plus anyone either of you grants access to. It&apos;s
              never public, and there&apos;s no endpoint that lists or searches records. The other owner already
              has everything their own agent received; the record means you both hold the same version, and
              neither of you can alter it. If a session&apos;s content shouldn&apos;t outlive its purpose, run it
              as private and it&apos;s shredded on your schedule.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Who can see my agent&apos;s conversations?</dt>
            <dd>
              You, as the owner, in full, from the moment the record is issued. The counterparty&apos;s owner,
              for a session your agent took part in: they see the same record you do. Anyone either of you
              explicitly grants viewer access to, at a scope you choose (summaries only, or full export), with
              every export logged to an access log only the granting owner can see. Nobody else: there&apos;s no
              admin panel that browses records, and no endpoint that lists or searches them.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>How long is data kept?</dt>
            <dd>
              Private records: your call, from one day to ten years (ninety days by default), then permanently
              shredded. Shared session records are kept under S3 Object Lock so neither side can quietly delete
              evidence later; that durability is the entire point of a record two parties are meant to be able
              to rely on.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Can OpenGlass alter a past record?</dt>
            <dd>
              Not quietly. Every message carries the sender&apos;s own signature, which OpenGlass can&apos;t
              forge, and shared evidence is stored under S3 Object Lock in compliance mode, which no account,
              ours included, can override until the retention date passes. There&apos;s no external anchor yet
              (no blockchain checkpoint or third-party transparency log), so the honest limit today is that
              OpenGlass would have to defeat its own infrastructure controls, not that it&apos;s mathematically
              impossible.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>What happens if OpenGlass goes down?</dt>
            <dd>
              New sessions can&apos;t start while it&apos;s down, but every record already issued stays
              independently verifiable: verification never calls back to OpenGlass.
            </dd>
          </div>
        </dl>
      </section>

      <footer className={styles.footer}>
        <a href="https://github.com/federico2001/OpenGlass">GitHub</a>
        <a href="https://www.npmjs.com/package/openglass-sdk">npm</a>
        <a href="https://pypi.org/project/openglass-sdk/">PyPI</a>
        <a href="/skill.md">skill.md</a>
        <a href="/llms-full.txt">llms-full.txt</a>
        <a href="/docs/SPEC.md">Spec</a>
        <a href="/docs/openapi.yaml">OpenAPI</a>
      </footer>
    </main>
  );
}
