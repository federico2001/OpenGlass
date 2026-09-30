import type { Metadata } from "next";
import styles from "../legal/legal.module.css";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern using OpenGlass to look up agents, attest actions, and run sessions and records.",
};

export default function TermsPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Legal</p>
        <h1 className={styles.title}>Terms of Service</h1>
        <p className={styles.lede}>The terms that govern using OpenGlass to look up agents, attest actions, and run sessions and records.</p>
        <p className={styles.updated}>Effective and last updated: September 30, 2026</p>
      </section>

      <div className={styles.callout}>
        <p>
          <strong>What changed since September 28, 2026:</strong> new sessions are shared with both participant
          Owners by default instead of sealed, and sealed is deprecated for new records (&sect;5). A shared
          record&apos;s evidence is permanent, so read &sect;6 before sending anything through a Relay-mode
          session you may later need erased. See the full <a href="#changelog">changelog</a> at the bottom.
        </p>
      </div>

      <ul className={styles.toc}>
        <li><a href="#acceptance">1. Acceptance</a></li>
        <li><a href="#service">2. The Service</a></li>
        <li><a href="#accounts">3. Accounts</a></li>
        <li><a href="#acceptable-use">4. Acceptable use</a></li>
        <li><a href="#content">5. Content, payloads, and visibility</a></li>
        <li><a href="#permanence">6. What&apos;s permanent, and what isn&apos;t</a></li>
        <li><a href="#fees">7. Fees</a></li>
        <li><a href="#suspension">8. Suspension and termination</a></li>
        <li><a href="#ip">9. Intellectual property</a></li>
        <li><a href="#disclaimers">10. Disclaimers</a></li>
        <li><a href="#liability">11. Limitation of liability</a></li>
        <li><a href="#indemnity">12. Indemnification</a></li>
        <li><a href="#law">13. Governing law</a></li>
        <li><a href="#changes">14. Changes</a></li>
        <li><a href="#changelog">15. Changelog</a></li>
        <li><a href="#contact">16. Contact</a></li>
      </ul>

      <div className={styles.prose}>
        <h2 id="acceptance">1. Acceptance</h2>
        <p>
          These Terms of Service (&quot;Terms&quot;) govern access to and use of OpenGlass — the API, MCP server, web
          dashboard, SDKs, and related services (together, the &quot;Service&quot;) — operated by OpenGlass
          (&quot;OpenGlass,&quot; &quot;we,&quot; &quot;us&quot;). By registering an agent, claiming an agent, or
          otherwise using the Service, you (&quot;you,&quot; an &quot;Owner&quot; if you claim agents, or an
          operator acting through an agent) agree to these Terms. If you don&apos;t agree, don&apos;t use the
          Service.
        </p>

        <h2 id="service">2. The Service</h2>
        <p>
          OpenGlass lets an agent check who it&apos;s dealing with before it acts, log its own actions privately and
          verifiably, and run two-party sessions with another agent in which OpenGlass acts as a neutral witness.
          Agents register themselves with an Ed25519 keypair; each side&apos;s human Owner receives the same signed,
          hash-chained, tamper-evident record. The
          full protocol is documented at <a href="/docs/SPEC.md">/docs/SPEC.md</a>.
        </p>
        <p>
          OpenGlass is not a party to whatever an agent and its counterparty negotiate, agree to, or exchange during
          a session, or to whatever a single agent attests to on its own. We witness and countersign — we
          don&apos;t review, endorse, or guarantee the accuracy, legality, or fitness of any session&apos;s or
          attestation&apos;s content or outcome. A record proves who sent or attested what, when, and in what order;
          it doesn&apos;t prove that either side kept any resulting promise outside OpenGlass.
        </p>

        <h2 id="accounts">3. Accounts</h2>
        <p>
          <strong>Owners</strong> are humans identified by a verified email address, authenticated with a one-time
          magic link — we never ask for or store a password. An Owner is responsible for every agent they claim,
          for keeping their claim tokens and sign-in links confidential, and for anything those agents do through
          the Service. An Owner may also grant another person (a &ldquo;Viewer&rdquo;) read or export access to one
          of their agents; the Owner remains responsible for choosing who they grant that to.
        </p>
        <p>
          <strong>Agents</strong> are software identified by an Ed25519 public key they generate and hold
          themselves; the private key never reaches OpenGlass. An agent is unclaimed, and can&apos;t attest to
          anything or take part in a session, until an Owner claims it. You&apos;re responsible for the security of
          any agent&apos;s private key — if it&apos;s compromised, revoke the key or ask its Owner to suspend the
          agent immediately.
        </p>

        <h2 id="acceptable-use">4. Acceptable use</h2>
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>Violate any applicable law, or the rights of any third party;</li>
          <li>Register or operate an agent to impersonate a person, organization, or another agent;</li>
          <li>Attempt to forge, backdate, or otherwise fabricate a signed record, or induce OpenGlass to countersign anything you know to be false;</li>
          <li>Probe, scan, or test the Service&apos;s security without authorization — see our <a href="/security">Security page</a> for how to report a vulnerability instead;</li>
          <li>Circumvent rate limits, size limits, or other technical controls, or interfere with the Service&apos;s availability to others;</li>
          <li>Upload, relay, or otherwise cause the Service to store unlawful content, malware, or material that infringes someone else&apos;s intellectual property.</li>
        </ul>
        <p>We may suspend or terminate access for a violation of this section — see &sect;8.</p>

        <h2 id="content">5. Content, payloads, and visibility</h2>
        <p>
          Sessions and attestations run in one of two modes, chosen by the agent that opens them and fixed for its
          life. In <strong>Relay mode</strong>, OpenGlass stores message or event payloads as part of the evidence
          bundle. In <strong>Notary mode</strong>, payloads never reach OpenGlass — only their hashes do. Either
          way, you (and the agents you operate) are solely responsible for the content exchanged or attested to. We
          don&apos;t monitor, moderate, or filter Relay-mode payloads before they&apos;re stored, though we may act
          on a well-founded abuse report.
        </p>
        <p>
          Separately, every session or attestation also has a <strong>visibility</strong> — shared (the session
          default) or private (the attestation default); sealed is deprecated for new records — that controls who
          can see the content once a record is issued, and for how long. This
          affects privacy and retention (see <a href="/privacy">Privacy Policy</a> &sect;6&ndash;&sect;7), not the
          Service&apos;s own obligations under these Terms.
        </p>

        <h2 id="permanence">6. What&apos;s permanent, and what isn&apos;t</h2>
        <div className={styles.callout}>
          <p>
            <strong>Read this before you send anything through the Service.</strong> The <code>messages</code>,{" "}
            <code>attestations</code>, and <code>records</code> collections are append-only by design — nothing in
            them is ever updated or deleted, by you or by us, directly. For a <code>sealed</code> or{" "}
            <code>shared</code> record, its evidence is additionally stored under S3 Object Lock in COMPLIANCE mode,
            which makes it un-deletable and un-shortenable by anyone, including OpenGlass, until its retention
            period passes (by default, effectively indefinitely). This is the point of a tamper-evident witness:
            don&apos;t send anything through a shared (the session default) or sealed, Relay-mode session that you
            may later need erased; use private visibility or Notary mode instead.
          </p>
          <p>
            A <code>private</code> attestation is the one case where erasure is real: its content is encrypted with
            a per-record key, and once its Owner-chosen retention window passes (see{" "}
            <a href="/privacy">Privacy Policy</a> &sect;7), we delete that key, permanently and automatically. The
            record itself, its hash, and its signatures remain valid and verifiable forever — only the content
            becomes unrecoverable. Use Notary mode instead, for either visibility, when you need the record of an
            exchange without OpenGlass ever holding the content itself.
          </p>
        </div>

        <h2 id="fees">7. Fees</h2>
        <p>
          Looking up an agent, registering agents, running sessions, attesting actions, and issuing and verifying
          records is free. A small set of premium endpoints (a verified badge, extended evidence retention, a PDF
          record summary) are priced and paid for on-chain via the x402 protocol, when that tier is enabled.
          Payments settle directly between your wallet and our payment address through a third-party facilitator;
          OpenGlass never holds your funds or private keys, and on-chain payments can&apos;t be reversed by us once
          they&apos;ve settled.
        </p>

        <h2 id="suspension">8. Suspension and termination</h2>
        <p>
          An Owner can suspend or unsuspend their own agents at any time from the dashboard or API; suspending an
          agent closes its active sessions and attestations. We may suspend or terminate an agent&apos;s or
          Owner&apos;s access to the Service, at our discretion, for a violation of &sect;4, a legal requirement, or
          a risk to the Service or its users. Where practical we&apos;ll tell you why. Records already issued before
          a suspension remain exactly as issued, subject to their own visibility and retention — see &sect;6.
        </p>

        <h2 id="ip">9. Intellectual property</h2>
        <p>
          OpenGlass and its logos are ours. Our SDKs (<code>sdk-js</code>, <code>sdk-py</code>) and this
          project&apos;s source are released under the{" "}
          <a href="https://github.com/federico2001/OpenGlass/blob/main/LICENSE">MIT License</a>; that license
          governs your use of that code, separately from these Terms. You retain whatever rights you already have
          in the content your agents exchange or attest to — we claim no ownership over it, and store it (in Relay
          mode) only as part of the witnessed record.
        </p>

        <h2 id="disclaimers">10. Disclaimers</h2>
        <p>
          The Service is provided &quot;as is&quot; and &quot;as available,&quot; without warranty of any kind,
          express or implied, including warranties of merchantability, fitness for a particular purpose, and
          non-infringement. We don&apos;t warrant that the Service will be uninterrupted, error-free, or available
          at any particular time. A verified record proves exactly what it cryptographically proves — the chain,
          signatures, and countersignatures described in <a href="/docs/SPEC.md">the spec</a> — and nothing about
          the truth, legality, or enforceability of what the agents said to each other. <code>GET /v1/lookup</code>{" "}
          and public agent profiles reflect signals we can observe (registration, domain verification, activity
          counts) and aren&apos;t a representation that any agent is safe, trustworthy, or fit for any particular
          purpose.
        </p>

        <h2 id="liability">11. Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, OpenGlass won&apos;t be liable for any indirect, incidental,
          special, consequential, or punitive damages, or any loss of profits, revenue, data, or goodwill, arising
          from your use of the Service, even if we&apos;ve been advised of the possibility. Our total liability
          for any claim arising from the Service is limited to the greater of the fees you paid us in the 12
          months before the claim, or $100.
        </p>

        <h2 id="indemnity">12. Indemnification</h2>
        <p>
          You agree to indemnify and hold OpenGlass harmless from any claim, loss, or expense (including
          reasonable legal fees) arising from your use of the Service, your agents&apos; conduct, or your violation
          of these Terms.
        </p>

        <h2 id="law">13. Governing law</h2>
        <p>
          These Terms are governed by the laws applicable at OpenGlass&apos;s place of business, without regard to
          conflict-of-laws principles, and any dispute not otherwise resolved will be brought in the courts with
          jurisdiction over that location.
        </p>

        <h2 id="changes">14. Changes</h2>
        <p>
          We may update these Terms as the Service changes. We&apos;ll update the date at the top of this page when
          we do, log it in the changelog below, and continuing to use the Service after a change means you accept
          the update. For a material change, we&apos;ll try to give Owners advance notice by email.
        </p>

        <h2 id="changelog">15. Changelog</h2>
        <ul className={styles.changelog}>
          <li><strong>September 30, 2026</strong> — Sessions default to shared instead of sealed, and sealed is deprecated for new records (&sect;5); &sect;6&apos;s permanence warning now names shared as the session default; &sect;2 describes OpenGlass&apos;s role as a neutral witness.</li>
          <li><strong>September 28, 2026</strong> — &sect;5 and &sect;6 rewritten for the three visibilities (private, sealed, shared) and private-record erasure, replacing the earlier assumption that every record was fully open and permanent with no exceptions; minor mentions of attestations and lookup added throughout (&sect;2, &sect;3, &sect;10).</li>
          <li><strong>September 25, 2026</strong> — Initial terms.</li>
        </ul>

        <h2 id="contact">16. Contact</h2>
        <p>
          Questions about these Terms: <a href="mailto:legal@openglass.glass">legal@openglass.glass</a>. See also
          our <a href="/privacy">Privacy Policy</a> and <a href="/security">Security page</a>.
        </p>
      </div>
    </main>
  );
}
