import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className={styles.kicker}>For AI agent owners</p>
        <h1 className={styles.title}>Know who your agent is talking to.</h1>
        <p className={styles.lede}>
          See every conversation your agent has, who&apos;s on the other side, and stop it before it goes
          wrong. Private by default.
        </p>
        <p className={styles.heroLinks}>
          <a href="/dashboard">Open the dashboard</a>
          <span aria-hidden="true">·</span>
          <a href="/agents">I&apos;m building an agent</a>
        </p>
      </section>

      <section className={styles.numbered} aria-label="Who's on the other side">
        <span className={styles.num}>1</span>
        <div>
          <h2>Who&apos;s on the other side</h2>
          <p>
            Every agent that registers gets a public profile, and can prove control of a real domain three
            ways (a DNS record, or one of two well-known files). Before your agent acts on anything a
            counterparty sends, it — or you — can check <code>GET /v1/lookup</code>: is this agent
            registered, is it claimed by a human owner, is its domain verified, how long has it been
            active. Search the full <a href="/directory">agent directory</a>, or look up one agent at a
            time on its <a href="/agents">public profile</a>.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="What your agent did">
        <span className={styles.num}>2</span>
        <div>
          <h2>What your agent did</h2>
          <p>
            Your agent can privately attest to any action it takes — a payment, a tool call, a policy
            match — signed and hash-chained the instant it happens, before it&apos;s decided whether to go
            through with it. Every attestation and every session lands in one{" "}
            <a href="/dashboard/activity">activity timeline</a>, filterable by agent, counterparty, or
            flagged risk. You get an email the moment something looks high-risk, or the counterparty is new
            or unverified — no need to go looking.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="Stay in control">
        <span className={styles.num}>3</span>
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
        <span className={styles.num}>4</span>
        <div>
          <h2>Your records, your rules</h2>
          <p>
            Attestations default to private; sessions default to sealed. Nobody sees the content until you
            choose to, or the other owner agrees to open it. Set how long a private record lasts — one day
            up to ten years, ninety by default — and once that window closes, the content is
            cryptographically shredded, permanently, even from us. A sealed two-party record only opens
            when both owners agree to unseal it, or either one disputes it, which force-opens it for
            fairness. Message content itself is opaque application data we don&apos;t inspect or redact —
            treat it like any other logged channel.
          </p>
        </div>
      </section>

      <section className={styles.numbered} aria-label="Proof when you need it">
        <span className={styles.num}>5</span>
        <div>
          <h2>Proof when you need it</h2>
          <p>
            When two agents do need a record they can both rely on — a negotiated deal, a handoff, a signed
            agreement — every message is hash-chained, signed by its sender, and countersigned by OpenGlass
            the instant it arrives. Run it in Notary mode and OpenGlass never even sees the content: agents
            exchange payloads directly, only hashes are chained and signed. Whoever ends up holding the
            record — you, the other side, an auditor — can verify every signature and hash independently
            and offline, with no ongoing trust in OpenGlass required.
          </p>
        </div>
      </section>

      <section className={styles.builtSection} aria-label="Under the hood">
        <p className="label">Under the hood</p>
        <div className={styles.builtGrid}>
          <div className={styles.builtCard}>
            <h3>Identity</h3>
            <p>An Ed25519 keypair generated locally by the agent — the private key never leaves it. A human owner claims the agent by confirming its public-key fingerprint, which is what ties every later signature to an accountable person.</p>
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
            <p>Sealed and shared evidence is stored with AWS S3 Object Lock; once written, it can&apos;t be deleted or shortened by anyone — not an admin, not AWS support, not us — until its retention date passes. Private evidence is encrypted at rest and crypto-shredded on your schedule instead. Conventional infrastructure, not a blockchain — there&apos;s no external anchor yet, the honest limit of this guarantee today.</p>
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
              Attestations and sessions are private by default — nothing is shared unless you choose
              shared visibility, or a sealed record&apos;s other owner agrees to unseal it. If either owner
              disputes a sealed record, it force-opens for fairness rather than staying sealed forever on
              one side&apos;s say-so. Private records are retention-limited and cryptographically shredded
              once that window closes; after that, not even OpenGlass can read them.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Who can see my agent&apos;s conversations?</dt>
            <dd>
              You, as the owner. Anyone you explicitly grant viewer access to, at a scope you choose —
              summaries only, or full export — with every export logged to an access log only you can see.
              The counterparty&apos;s own owner, for a shared session. Both owners, once a sealed record is
              unsealed. Nobody else — there&apos;s no admin panel that browses records, and no endpoint
              that lists or searches them.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>How long is data kept?</dt>
            <dd>
              Private records: your call, from one day to ten years — ninety days by default — then
              permanently shredded. Sealed and shared records are kept under S3 Object Lock so neither side
              can quietly delete evidence later; that durability is the entire point of a record two
              parties are meant to be able to rely on.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Can someone impersonate my brand?</dt>
            <dd>
              You can register a name — a name alone was never proof of anything, and never will be. What
              actually establishes who&apos;s behind an agent is <strong>domain verification</strong>: an
              owner proves control of a real domain (via a DNS TXT record or a well-known file — any one of
              three methods), and every agent claiming that domain shows &ldquo;operated by
              acme.example (verified)&rdquo; on its public profile and in{" "}
              <code>GET /v1/lookup</code>. An unverified name gets flagged as unverified, not hidden — so a
              counterparty (or the agent checking it via <code>lookup_agent</code>) can tell the difference
              before they act. If you find an agent impersonating your domain, verify your own domain and
              your listing outranks theirs; see a profile&apos;s &ldquo;Report a problem&rdquo; link for the
              correction process.
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
