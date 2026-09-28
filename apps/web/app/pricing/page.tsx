import type { Metadata } from "next";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "OpenGlass's core protocol — lookup, registration, attestations, sealed sessions, and the full owner " +
    "dashboard — is free, with no account tiers. A few optional add-ons are pay-per-use via x402 (USDC on Base).",
};

export default function PricingPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Pricing</p>
        <h1 className={styles.title}>The core protocol is free. No account tiers.</h1>
        <p className={styles.lede}>
          Registering agents, looking up counterparties, attesting actions, running sealed sessions, and
          the full owner dashboard — oversight alerts, viewer grants, retention control — cost nothing and
          need no subscription. The only things that cost anything are a few optional add-ons, paid per use
          in USDC, with no account required to pay.
        </p>
      </section>

      <section className={styles.block}>
        <p className={styles.tag}>Free</p>
        <h2>Everything, by default</h2>
        <ul className={styles.list}>
          <li><code>GET /v1/lookup</code> — check any agent before you act, unauthenticated, no limit beyond the shared rate limit</li>
          <li>Register agents and get them claimed by a human owner</li>
          <li>Private attestations, hash-chained and signed</li>
          <li>Sealed and shared two-party sessions, Notary mode</li>
          <li>Owner dashboard: activity timeline, alerts, pause/approve, viewer grants with a scope and access log</li>
          <li>Retention control on private records — one day to ten years, ninety by default</li>
          <li>Domain verification, public agent profile and directory listing</li>
          <li>REST API, MCP server, JS and Python SDKs, offline bundle verification</li>
        </ul>
      </section>

      <section className={styles.block}>
        <p className={styles.tag}>Pay as you go — x402, USDC on Base</p>
        <h2>Optional add-ons, per use</h2>
        <p className={styles.blockLede}>
          No account, no subscription, no recurring charge — a request without payment gets a standard 402
          back with what to pay; pay it and retry.
        </p>
        <dl className={styles.priceList}>
          <div>
            <dt>Verified badge</dt>
            <dd><span className={styles.price}>$1.00</span> once per agent</dd>
          </div>
          <div>
            <dt>Extended retention</dt>
            <dd><span className={styles.price}>$0.50</span> per record, extends storage retention to ten years</dd>
          </div>
          <div>
            <dt>PDF export</dt>
            <dd><span className={styles.price}>$0.25</span> per record</dd>
          </div>
        </dl>
      </section>

      <section className={styles.faq}>
        <p className="label">Straight answers</p>
        <dl>
          <div className={styles.faqItem}>
            <dt>Why isn&apos;t there a paid plan?</dt>
            <dd>
              Because we haven&apos;t built one. If you were expecting an &ldquo;Owner&rdquo; or
              &ldquo;Business&rdquo; subscription tier here, we don&apos;t have one — everything the
              dashboard does today is available to any owner for free. If usage grows enough that we need
              to introduce paid tiers later, this page will say so plainly, and nothing you&apos;re already
              relying on will start requiring payment retroactively.
            </dd>
          </div>
          <div className={styles.faqItem}>
            <dt>What does the verified badge actually verify?</dt>
            <dd>
              Nothing new — it&apos;s a visible marker that an agent&apos;s owner cared enough to pay for
              it. The thing that actually establishes who&apos;s behind an agent, domain verification, is
              already free; see <a href="/agents">/agents</a>.
            </dd>
          </div>
        </dl>
      </section>

      <footer className={styles.footer}>
        <a href="/agents">For agents &amp; developers</a>
        <a href="/dashboard">Open the dashboard</a>
        <a href="/docs/openapi.yaml">OpenAPI</a>
      </footer>
    </main>
  );
}
