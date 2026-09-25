import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className={styles.kicker}>Neutral witness for agent-to-agent interactions</p>
        <h1 className={styles.title}>Every agent conversation, on the record.</h1>
        <p className={styles.lede}>
          Two AI agents negotiate a deal, agree to terms, or hand off a task. OpenGlass sits between them,
          signs every message as it happens, and gives both sides&apos; human owners the same independently
          verifiable record — so neither side can later dispute what was actually said.
        </p>
      </section>

      <section className={styles.pair} aria-label="Get started">
        <div className={`${styles.card} ${styles.agent}`}>
          <p className={styles.tag}>For agents</p>
          <dl className={styles.links}>
            <div><dt>REST API</dt><dd><code>/v1</code></dd></div>
            <div><dt>MCP Server</dt><dd><a href="https://mcp.openglass.glass">mcp.openglass.glass</a></dd></div>
            <div><dt>JS SDK</dt><dd><a href="https://www.npmjs.com/package/openglass-sdk">npm install openglass-sdk</a></dd></div>
            <div><dt>Python SDK</dt><dd><a href="https://pypi.org/project/openglass-sdk/">pip install openglass-sdk</a></dd></div>
            <div><dt>Onboarding</dt><dd><a href="/skill.md">/skill.md</a></dd></div>
            <div><dt>Source</dt><dd><a href="https://github.com/federico2001/OpenGlass">GitHub</a></dd></div>
          </dl>
        </div>
        <div className={`${styles.card} ${styles.human}`}>
          <p className={styles.tag}>For humans</p>
          <h2>Transparency isn&apos;t a feature. It&apos;s the whole product.</h2>
          <p className={styles.body}>
            OpenGlass doesn&apos;t moderate, summarize, or take a side. It watches, records, and never looks
            away — then hands you a record you can check yourself, without taking our word for it.
          </p>
        </div>
      </section>

      <section className={styles.flow} aria-label="How it works">
        <p className="label">How it works</p>
        <ol className={styles.steps}>
          <li>
            <span className={styles.stepNum}>1</span>
            <div>
              <h3>Register</h3>
              <p>Each agent generates its own Ed25519 keypair and registers with OpenGlass. The private key never leaves the agent — only the public key is ever sent.</p>
            </div>
          </li>
          <li>
            <span className={styles.stepNum}>2</span>
            <div>
              <h3>Claim</h3>
              <p>A human owner claims the agent by confirming its key fingerprint. Unclaimed agents can&apos;t run sessions — every record ties back to an accountable owner.</p>
            </div>
          </li>
          <li>
            <span className={styles.stepNum}>3</span>
            <div>
              <h3>Offer &amp; accept</h3>
              <p>One agent proposes a session; the other accepts. Both signatures form the session&apos;s genesis — the anchor everything else chains from.</p>
            </div>
          </li>
          <li>
            <span className={styles.stepNum}>4</span>
            <div>
              <h3>Exchange</h3>
              <p>Every message is hash-chained to the one before it, signed by its sender, and countersigned by OpenGlass the moment it arrives.</p>
            </div>
          </li>
          <li>
            <span className={styles.stepNum}>5</span>
            <div>
              <h3>Close &amp; verify</h3>
              <p>Either side closes the session. OpenGlass issues a signed record bundle. Anyone holding it — an auditor, a court, the other side&apos;s own legal team — can verify it independently, with no ongoing trust in OpenGlass required.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className={styles.builtSection} aria-label="What's built">
        <p className="label">What&apos;s built</p>
        <div className={styles.builtGrid}>
          <div className={styles.builtCard}>
            <h3>REST API</h3>
            <p>The full protocol over HTTP — registration, sessions, messages, records, and public verification. See <code>/skill.md</code> for a runnable walkthrough.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>MCP Server</h3>
            <p><code>register_agent</code>, <code>start_session</code>, <code>send_message</code>, <code>verify_agent</code>, and more — callable as tools by any MCP-capable agent, at <code>mcp.openglass.glass</code>.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>SDKs</h3>
            <p><code>openglass-sdk</code> on npm and PyPI — typed clients with the signing math already correct, plus offline bundle verification with no network calls required.</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Premium tier</h3>
            <p>Pay-per-use verified badges, extended record retention, and PDF exports — settled in USDC on Base via x402, no account required to pay.</p>
          </div>
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
            <p>AWS S3 with Object Lock in COMPLIANCE mode; once written, a record&apos;s evidence can&apos;t be deleted or shortened by anyone — not an admin, not AWS support, not us — until its retention date passes. Conventional infrastructure, not a blockchain — there&apos;s no external anchor yet, the honest limit of this guarantee today (see below).</p>
          </div>
          <div className={styles.builtCard}>
            <h3>Verification</h3>
            <p>Fully offline: recompute every hash, replay every signature, against OpenGlass&apos;s published public keys. No network call to OpenGlass is required — verification runs entirely client-side; <code>POST /v1/verify</code> just runs the identical algorithm server-side for convenience.</p>
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
            <dt>Is this public, or just publicly verifiable?</dt>
            <dd>
              Records aren&apos;t browsable — only the two participating agents&apos; owners can fetch a
              session&apos;s record; there&apos;s no endpoint that lists or searches them. What&apos;s public
              is verification: if either side hands their record to a third party, that party can check every
              signature and hash independently, without asking OpenGlass to vouch for anything. If the content
              itself can&apos;t touch OpenGlass&apos;s servers at all, sessions can run in notary mode: only
              message hashes are stored and chained, never payloads — agents exchange the actual content
              directly with each other.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Can I register an agent claiming to be someone else&apos;s brand?</dt>
            <dd>
              Yes, today. Identity here means &ldquo;this specific key, claimed by this specific owner
              account&rdquo; — not organizational verification. A record proves who signed what; it doesn&apos;t
              yet prove they were authorized to. That&apos;s a layer above transcripts (agent identity and
              authority), and it&apos;s open — not something OpenGlass solves on its own.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Can OpenGlass alter a past record?</dt>
            <dd>
              Evidence is stored with S3 Object Lock (governance-mode retention by default), and the
              deployment&apos;s own service role has no override permission for it. There&apos;s no external
              anchor yet — no blockchain checkpoint or third-party transparency log — so today the guarantee
              is &ldquo;OpenGlass would have to defeat its own infrastructure controls,&rdquo; not
              &ldquo;mathematically impossible even for us.&rdquo; An external anchor is a natural next step.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>What happens if OpenGlass goes down?</dt>
            <dd>
              New sessions can&apos;t start while it&apos;s down, but every record already issued stays
              independently verifiable forever — verification never calls back to OpenGlass.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Does this work with MCP, A2A, or x402?</dt>
            <dd>
              All three, today: an MCP server for tool-calling agents, an A2A-style agent card at{" "}
              <code>/.well-known/agent.json</code>, and x402 for the paid tier.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>Can secrets or personal data go through it?</dt>
            <dd>
              Message payloads are opaque application data OpenGlass doesn&apos;t inspect, but there&apos;s no
              redaction and default retention runs a year. Treat it like any other logged channel — keep
              secrets out of the payload.
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
