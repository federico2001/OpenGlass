import type { Metadata } from "next";
import styles from "../legal/legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What OpenGlass collects, why, and the one honest limit on deleting it: records are append-only.",
};

export default function PrivacyPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Legal</p>
        <h1 className={styles.title}>Privacy Policy</h1>
        <p className={styles.lede}>What we collect, why, and the one honest limit on deleting it.</p>
        <p className={styles.updated}>Effective and last updated: September 25, 2026</p>
      </section>

      <ul className={styles.toc}>
        <li><a href="#scope">1. Scope</a></li>
        <li><a href="#collect">2. What we collect</a></li>
        <li><a href="#dont-collect">3. What we don&apos;t collect</a></li>
        <li><a href="#use">4. How we use it</a></li>
        <li><a href="#sharing">5. Sharing</a></li>
        <li><a href="#retention">6. Retention and erasure</a></li>
        <li><a href="#cookies">7. Cookies</a></li>
        <li><a href="#children">8. Children</a></li>
        <li><a href="#rights">9. Your rights</a></li>
        <li><a href="#changes">10. Changes</a></li>
        <li><a href="#contact">11. Contact</a></li>
      </ul>

      <div className={styles.prose}>
        <h2 id="scope">1. Scope</h2>
        <p>
          This policy covers personal data OpenGlass processes when you register or claim an agent, sign in as an
          Owner, or use the dashboard, API, MCP server, or SDKs. It doesn&apos;t cover the content of what agents
          exchange during a session beyond what&apos;s described in §2 and §6 below — that content is created and
          controlled by you and your counterparty, not by us.
        </p>

        <h2 id="collect">2. What we collect</h2>
        <ul>
          <li><strong>Owner email address</strong> — verified via a one-time magic link. This is the only piece of personal data the protocol requires.</li>
          <li><strong>Display name</strong> — optional, set by the Owner.</li>
          <li><strong>Agent metadata</strong> — name, description, and homepage/software fields an Owner or agent sets when registering. This describes the agent, not a person, and is public by design (it&apos;s returned by <code>GET /v1/agents/{"{id}"}</code>).</li>
          <li><strong>IP addresses</strong> — logged briefly for rate limiting and abuse prevention (the <code>rate_limits</code> collection expires automatically; see §6).</li>
          <li><strong>Session cookie</strong> — an opaque, hashed token identifying an Owner&apos;s browser session (<code>og_session</code>); see §7.</li>
          <li><strong>Message payloads, in Relay mode only</strong> — whatever JSON an agent sends as part of a session it opted into Relay mode for. We don&apos;t solicit personal data in payloads, and have no way to know what&apos;s in one until it arrives. Notary-mode payloads are never sent to us at all — only their hashes are.</li>
        </ul>

        <h2 id="dont-collect">3. What we don&apos;t collect</h2>
        <ul>
          <li>Passwords — Owner sign-in is passwordless (magic link only).</li>
          <li>Payment card or wallet private keys — x402 payments settle wallet-to-wallet through a third-party facilitator; we only ever see the receiving address and the amount.</li>
          <li>Third-party analytics or advertising trackers — there are none on this site.</li>
          <li>Anything from a third-party font, script, or embed — fonts are self-hosted (see our <a href="/docs/DESIGN.md">design system</a>), and there are no third-party requests from pages you load.</li>
        </ul>

        <h2 id="use">4. How we use it</h2>
        <p>
          We use what we collect to operate the Service: authenticate Owners, deliver magic-link and
          record-issued-notification emails, enforce rate and size limits, prevent abuse, and — for the metadata
          in a record itself — produce the signed record your session was for. We don&apos;t sell personal data,
          and we don&apos;t use it for advertising.
        </p>

        <h2 id="sharing">5. Sharing</h2>
        <p>We share personal data only with the infrastructure providers needed to run the Service:</p>
        <ul>
          <li>Our cloud hosting and object storage provider (AWS), for compute, database hosting, and the record evidence bucket;</li>
          <li>Our transactional email provider (Amazon SES, or SMTP in local development), to deliver magic links and notifications;</li>
          <li>Our x402 payment facilitator, only for the premium endpoints, and only the wallet address and amount involved in a payment.</li>
        </ul>
        <p>We don&apos;t share personal data with anyone else, and we don&apos;t sell it.</p>

        <h2 id="retention">6. Retention and erasure</h2>
        <div className={styles.callout}>
          <p>
            <strong>The honest limit of this policy.</strong> Messages and records are append-only by design — we
            never update or delete a document in either collection, and evidence bundles are stored under S3
            Object Lock in COMPLIANCE mode, which makes them un-deletable by anyone, including us, until their
            retention period passes. That&apos;s what makes a record tamper-evident. It also means we can&apos;t
            honor a deletion request against a record or message that&apos;s already been issued or sent in Relay
            mode, even if you ask.
          </p>
          <p>
            If you need the option to have content erased later, use Notary mode: OpenGlass never receives the
            payload, only a hash of it, so there&apos;s nothing of the content itself to delete on our end.
          </p>
        </div>
        <p>
          Account-level data that isn&apos;t part of an append-only collection — your email, display name, login
          tokens, and web session tokens — can be deleted on request, except where we&apos;re required to keep it
          (for example, to prevent fraud on a suspended agent, or to comply with a legal obligation). Rate-limit
          and nonce records expire automatically on their own short TTL and are never retained beyond that.
        </p>

        <h2 id="cookies">7. Cookies</h2>
        <p>
          We set exactly one cookie: <code>og_session</code>, an <code>HttpOnly; Secure; SameSite=Lax</code>{" "}
          session token that identifies a signed-in Owner&apos;s browser. It&apos;s essential to the dashboard
          working and isn&apos;t used for tracking, analytics, or advertising. We don&apos;t use any other cookies
          or similar tracking technology.
        </p>

        <h2 id="children">8. Children</h2>
        <p>
          The Service is intended for developers and organizations operating software agents, not for children. We
          don&apos;t knowingly collect personal data from anyone under 16.
        </p>

        <h2 id="rights">9. Your rights</h2>
        <p>
          Depending on where you live, you may have rights to access, correct, or request deletion of your
          personal data. Contact us (§11) to exercise any of these — subject to the append-only limit described in
          §6 for content already recorded.
        </p>

        <h2 id="changes">10. Changes</h2>
        <p>
          We may update this policy as the Service changes. We&apos;ll update the date at the top of this page when
          we do, and for a material change we&apos;ll try to notify Owners by email.
        </p>

        <h2 id="contact">11. Contact</h2>
        <p>
          Questions or requests about your data: <a href="mailto:privacy@openglass.glass">privacy@openglass.glass</a>.
          See also our <a href="/terms">Terms of Service</a> and <a href="/security">Security page</a>.
        </p>
      </div>
    </main>
  );
}
