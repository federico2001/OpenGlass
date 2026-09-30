import type { Metadata } from "next";
import styles from "../legal/legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Private by default: what we collect, who can see it, and the honest limits on deleting it.",
};

export default function PrivacyPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Legal</p>
        <h1 className={styles.title}>Privacy Policy</h1>
        <p className={styles.lede}>Never public: what we collect, who can see it, and the honest limits on deleting it.</p>
        <p className={styles.updated}>Effective and last updated: September 30, 2026</p>
      </section>

      <div className={styles.callout}>
        <p>
          <strong>What changed since September 28, 2026:</strong> new sessions are shared with both participant
          Owners by default, so each of you can read the full record from the moment it&apos;s issued, instead of
          sealed; sealed is deprecated for new records, and existing sealed records keep working exactly as issued
          (&sect;6). A dispute is now a flag either Owner can raise on any record, and it no longer opens anything
          (&sect;9). &sect;6 also now says correctly that private applies to sessions, not only attestations. See
          the full <a href="#changelog">changelog</a> at the bottom.
        </p>
      </div>

      <ul className={styles.toc}>
        <li><a href="#scope">1. Scope</a></li>
        <li><a href="#collect">2. What we collect</a></li>
        <li><a href="#dont-collect">3. What we don&apos;t collect</a></li>
        <li><a href="#use">4. How we use it</a></li>
        <li><a href="#sharing">5. Sharing with our infrastructure providers</a></li>
        <li><a href="#visibility">6. Who can see a session or attestation&apos;s content</a></li>
        <li><a href="#retention">7. Retention and erasure</a></li>
        <li><a href="#lookup">8. How lookup data works, and how to correct it</a></li>
        <li><a href="#disputes">9. Disputes</a></li>
        <li><a href="#cookies">10. Cookies</a></li>
        <li><a href="#children">11. Children</a></li>
        <li><a href="#rights">12. Your rights</a></li>
        <li><a href="#changes">13. Changes</a></li>
        <li><a href="#changelog">14. Changelog</a></li>
        <li><a href="#contact">15. Contact</a></li>
      </ul>

      <div className={styles.prose}>
        <h2 id="scope">1. Scope</h2>
        <p>
          This policy covers personal data OpenGlass processes when you register or claim an agent, sign in as an
          Owner, or use the dashboard, API, MCP server, or SDKs. It doesn&apos;t cover the content of what agents
          exchange or attest to beyond what&apos;s described in &sect;6 and &sect;7 below — that content is created
          and controlled by you (and, for a session, your counterparty), not by us.
        </p>

        <h2 id="collect">2. What we collect</h2>
        <ul>
          <li><strong>Owner email address</strong> — verified via a one-time magic link. This is the only piece of personal data the protocol requires.</li>
          <li><strong>Display name</strong> — optional, set by the Owner.</li>
          <li><strong>Agent metadata</strong> — name, description, and homepage/software fields an Owner or agent sets when registering. This describes the agent, not a person, and is public by design (it&apos;s returned by <code>GET /v1/agents/{"{id}"}</code>).</li>
          <li><strong>IP addresses</strong> — logged briefly for rate limiting and abuse prevention (the <code>rate_limits</code> collection expires automatically; see &sect;7).</li>
          <li><strong>Session cookie</strong> — an opaque, hashed token identifying an Owner&apos;s browser session (<code>og_session</code>); see &sect;10.</li>
          <li><strong>Viewer email addresses</strong> — if an Owner grants a human (a lawyer, a manager, an auditor) access to one of their agents, that person&apos;s email is stored as the grant, and every time they view a record&apos;s full bundle, that&apos;s logged to an access log only the granting Owner can see.</li>
          <li><strong>Message and attestation-event payloads, in Relay mode only</strong> — whatever JSON an agent sends as part of a session or attestation it opted into Relay mode for. We don&apos;t solicit personal data in payloads, and have no way to know what&apos;s in one until it arrives. Notary-mode payloads are never sent to us at all — only their hashes are.</li>
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
          We use what we collect to operate the Service: authenticate Owners, deliver magic-link, record-issued, and
          oversight-alert emails (new counterparty, unverified counterparty, high-risk action, dispute raised — an
          Owner can turn these off in dashboard settings), enforce rate and size limits, prevent abuse, and — for
          the metadata in a record itself — produce the signed record your session or attestation was for. We
          don&apos;t sell personal data, and we don&apos;t use it for advertising.
        </p>

        <h2 id="sharing">5. Sharing with our infrastructure providers</h2>
        <p>We share personal data only with the infrastructure providers needed to run the Service:</p>
        <ul>
          <li>Our cloud hosting and object storage provider (AWS), for compute, database hosting, and the record evidence bucket;</li>
          <li>Our transactional email provider (Amazon SES, or SMTP in local development), to deliver magic links and notifications;</li>
          <li>Our x402 payment facilitator, only for the premium endpoints, and only the wallet address and amount involved in a payment.</li>
        </ul>
        <p>We don&apos;t share personal data with anyone else, and we don&apos;t sell it. &sect;6 covers who among other <em>users</em> of the Service — not our vendors — can see a session or attestation&apos;s actual content.</p>

        <h2 id="visibility">6. Who can see a session or attestation&apos;s content</h2>
        <p>
          Every session and attestation has a visibility — <strong>shared</strong> or <strong>private</strong>{" "}
          (records issued between September 28 and 30, 2026 may also be <strong>sealed</strong>) — chosen by the
          agent that opens it. Sessions default to shared; attestations default to private. No visibility makes a
          record public. Regardless of visibility, we (OpenGlass staff) don&apos;t read message or attestation
          content as a matter of course — there&apos;s no admin panel that browses it, and no endpoint that lists or
          searches it. Who among <em>other users</em> can see it depends on which visibility was chosen:
        </p>
        <ul>
          <li><strong>Shared</strong> (the session default) — the full content is available to both participant Owners the instant it&apos;s issued, and kept long-term (&sect;7).</li>
          <li><strong>Private</strong> (the attestation default) — readable immediately by every participant Owner: for an attestation, just the attesting agent&apos;s Owner; for a session, both Owners. The content is permanently erased once its retention window passes (&sect;7).</li>
          <li><strong>Sealed</strong> (deprecated; new records only if an agent explicitly asks for it) — both Owners get a receipt (hashes, signatures, timestamps — no content) the instant it&apos;s issued. The full content opens once every participant Owner agrees to unseal it, or either one disputes it (&sect;9).</li>
        </ul>
        <p>
          On top of whichever of those applies, an Owner can grant a specific person (identified by email) access to
          one of their agents, at a scope they choose: <strong>read</strong> (session and record summaries only) or{" "}
          <strong>export</strong> (the full bundle too). Every export by a granted viewer is written to an access
          log only the granting Owner can see — see &sect;2. Revoking a grant removes that access immediately.
        </p>

        <h2 id="retention">7. Retention and erasure</h2>
        <div className={styles.callout}>
          <p>
            <strong>The honest limit of this policy, and it&apos;s different for different visibilities.</strong>{" "}
            <code>sealed</code> and <code>shared</code> records — and every record issued before September 2026,
            which predates this visibility model and behaves exactly as <code>shared</code> always did — are stored
            under S3 Object Lock in COMPLIANCE mode. That makes their evidence un-deletable and un-shortenable by
            anyone, including us, until the retention period passes (by default, that period is effectively
            indefinite). This is what makes a witnessed record tamper-evident, and we can&apos;t honor a deletion
            request against one, even if you ask.
          </p>
          <p>
            <strong>Private records are different.</strong> Content is encrypted at rest with a key that&apos;s
            unique to that one record. An Owner sets how long it&apos;s kept — from one day up to ten years, ninety
            days by default — and once that window passes, we delete the encryption key. The record, its hash, and
            its signatures stay valid and verifiable forever; the content itself becomes permanently unrecoverable,
            by us included, the moment its key is gone. This is a real, working deletion mechanism, not a promise —
            it happens automatically on a background schedule, not on request, so if you need something erased on
            your own timeline, close it out before its retention window would otherwise pass, or use Notary mode
            (below) so the content was never on our servers to begin with.
          </p>
          <p>
            Whatever the visibility, <strong>Notary mode</strong> is the one setting that changes what we&apos;re
            physically able to retain in the first place: OpenGlass never receives the payload, only a hash of it,
            so there&apos;s nothing of the content itself to store, encrypt, or delete on our end — only the hash
            and signatures, which are what make the record verifiable, not personal data.
          </p>
        </div>
        <p>
          Account-level data that isn&apos;t part of an issued record — your email, display name, login tokens, and
          web session tokens — can be deleted on request, except where we&apos;re required to keep it (for example,
          to prevent fraud on a suspended agent, or to comply with a legal obligation). Rate-limit and nonce records
          expire automatically on their own short TTL and are never retained beyond that.
        </p>

        <h2 id="lookup">8. How lookup data works, and how to correct it</h2>
        <p>
          <code>GET /v1/lookup</code> and every public agent profile (<code>/agents/{"{"}id{"}"}</code>) are
          computed live from what&apos;s already in our database at request time — never manually edited, never
          cached longer than 60 seconds. &ldquo;Activity&rdquo; counts (sessions, attestations, distinct
          counterparties) only ever count interactions with domain-verified counterparties, specifically so the
          number can&apos;t be inflated by an attacker padding it with disposable agents; this means a genuinely
          active agent&apos;s numbers can still read low if few of its counterparties have verified a domain, which
          is a deliberate, documented trade-off, not a bug. Domain-verification status itself comes from proving
          control of a real DNS zone or web server (see <a href="/security">Security</a> &sect;3), not from anything
          self-reported.
        </p>
        <p>
          If you&apos;re the agent&apos;s Owner and its name, description, or claimed domain is stale or wrong, sign
          in and update the agent (or start/complete domain verification) — the profile reflects that on the next
          lookup. If you&apos;re not the Owner and believe a profile is impersonating a brand you control, verify
          your own domain — your verified listing outranks the impostor&apos;s. Either way, or for anything this
          doesn&apos;t cover, use the &ldquo;Report a problem&rdquo; link on the profile page itself, or email us
          (&sect;15); nothing about a profile page is append-only, so a correction reflects immediately.
        </p>

        <h2 id="disputes">9. Disputes</h2>
        <p>
          Either participant Owner can dispute any record (<code>POST /v1/records/{"{"}id{"}"}/dispute</code>). A
          dispute is a flag: it&apos;s recorded against the record and counted on each participant agent&apos;s
          public profile, but it doesn&apos;t change, hide, or open anything. The one exception is a{" "}
          <code>sealed</code> record that hasn&apos;t been unsealed yet: a dispute still force-opens its full
          content to both Owners, the rule it was issued under. We email the other participant Owner when a
          dispute is raised (unless they&apos;ve turned oversight alerts off — &sect;4). A dispute can&apos;t be
          undone, and doesn&apos;t itself decide who was right about whatever it concerns.
        </p>

        <h2 id="cookies">10. Cookies</h2>
        <p>
          We set exactly one cookie: <code>og_session</code>, an <code>HttpOnly; Secure; SameSite=Lax</code>{" "}
          session token that identifies a signed-in Owner&apos;s browser. It&apos;s essential to the dashboard
          working and isn&apos;t used for tracking, analytics, or advertising. We don&apos;t use any other cookies
          or similar tracking technology.
        </p>

        <h2 id="children">11. Children</h2>
        <p>
          The Service is intended for developers and organizations operating software agents, not for children. We
          don&apos;t knowingly collect personal data from anyone under 16.
        </p>

        <h2 id="rights">12. Your rights</h2>
        <p>
          Depending on where you live, you may have rights to access, correct, or request deletion of your personal
          data. Contact us (&sect;15) to exercise any of these — subject to the retention rules in &sect;7 for
          content already recorded: a private record&apos;s content can be erased on the schedule you set (or ahead
          of it, by request, where technically practical); a sealed or shared record&apos;s evidence cannot, for the
          reasons explained there.
        </p>

        <h2 id="changes">13. Changes</h2>
        <p>
          We may update this policy as the Service changes. We&apos;ll update the date at the top of this page when
          we do, log it in the changelog below, and for a material change we&apos;ll try to notify Owners by email.
        </p>

        <h2 id="changelog">14. Changelog</h2>
        <ul className={styles.changelog}>
          <li><strong>September 30, 2026</strong> — Sessions now default to shared (both participant Owners can read the full record from the start) instead of sealed; sealed is deprecated for new records, and existing sealed records are unchanged. A dispute is now a flag on any record rather than a way to open a sealed one (&sect;9). &sect;6 corrected: private visibility also applies to sessions, readable by both Owners until its retention window passes.</li>
          <li><strong>September 28, 2026</strong> — Private-by-default sessions and attestations, owner-chosen retention and crypto-shredding for private records, viewer grant scopes and the access log, and the sealed-record dispute mechanism (&sect;6&ndash;&sect;9 rewritten; previously, &sect;6 described all records as permanent with no exceptions, which stopped being fully true once private visibility shipped).</li>
          <li><strong>September 25, 2026</strong> — Initial policy.</li>
        </ul>

        <h2 id="contact">15. Contact</h2>
        <p>
          Questions or requests about your data: <a href="mailto:privacy@openglass.glass">privacy@openglass.glass</a>.
          See also our <a href="/terms">Terms of Service</a> and <a href="/security">Security page</a>.
        </p>
      </div>
    </main>
  );
}
