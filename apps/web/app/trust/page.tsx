import type { Metadata } from "next";
import styles from "../legal/legal.module.css";

export const metadata: Metadata = {
  title: "Trust",
  description:
    "What OpenGlass is, what you can check yourself, who can see a record, how long it's kept, and what doesn't exist yet.",
};

export default function TrustPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Trust</p>
        <h1 className={styles.title}>What you can rely on, and what you can&apos;t yet</h1>
        <p className={styles.lede}>
          Everything on this page describes how OpenGlass works today, with the same facts as the{" "}
          <a href="/docs/SPEC.md">protocol spec</a>. It claims no certification, SLA or customer, because there are none
          to claim.
        </p>
      </section>

      <ul className={styles.toc}>
        <li><a href="#what">What OpenGlass is</a></li>
        <li><a href="#check">What you can check yourself</a></li>
        <li><a href="#who">Who can see a record</a></li>
        <li><a href="#retention">Retention and deletion</a></li>
        <li><a href="#controls">Controls you have</a></li>
        <li><a href="#not-yet">What doesn&apos;t exist yet</a></li>
        <li><a href="#details">Operations</a></li>
      </ul>

      <div className={styles.prose}>
        <h2 id="what">What OpenGlass is</h2>
        <p>
          OpenGlass is a neutral witness for interactions between AI agents. Two agents run a session through
          OpenGlass. Each message is hash-chained to the one before it, signed by the agent that sent it and
          countersigned by OpenGlass when it arrives. When the session closes, both owners get the same record.
        </p>
        <p>OpenGlass doesn&apos;t moderate, summarize, score or take a side.</p>

        <h2 id="check">What you can check yourself</h2>
        <ul>
          <li>Agent signatures are Ed25519 over RFC&nbsp;8785 canonical JSON, with a purpose prefix so a signature made for one step can&apos;t be replayed as another.</li>
          <li>OpenGlass countersigns with ECDSA P-256. Its public keys are published at <a href="/.well-known/openglass-keys.json">/.well-known/openglass-keys.json</a>.</li>
          <li>Anyone holding a record can recompute every hash and replay every signature offline. The public <code>POST /v1/verify</code> endpoint runs the same algorithm, for convenience only.</li>
          <li>Records already issued stay verifiable if OpenGlass goes down, because verification never calls back to us.</li>
          <li>The protocol spec and OpenAPI schema are public at <a href="/docs/SPEC.md">/docs/SPEC.md</a> and <a href="/docs/openapi.yaml">/docs/openapi.yaml</a>, and the code is open source.</li>
        </ul>

        <h2 id="who">Who can see a record</h2>
        <ul>
          <li><strong>Session record:</strong> shared by default, so both owners can read the full record. Never public. No endpoint lists or searches records.</li>
          <li><strong>Attestation:</strong> private to the attesting agent&apos;s owner by default.</li>
          <li><strong>Viewers:</strong> an owner can grant a named person read-only or export access to one agent. Each export is written to an access log only that owner sees.</li>
          <li><strong>OpenGlass:</strong> there&apos;s no admin panel that browses records and no endpoint that lists them. OpenGlass runs the servers that store relay-mode content, though, so the operator could technically read it. Production access goes through AWS Systems Manager, which authenticates and logs every session; there&apos;s no SSH.</li>
        </ul>
        <p>
          Message content is opaque application data. OpenGlass doesn&apos;t inspect or redact it, so treat it like any
          other logged channel. In Notary mode OpenGlass never sees the content at all: the agents exchange payloads
          directly, and only hashes are chained and signed.
        </p>

        <h2 id="retention">Retention and deletion</h2>
        <ul>
          <li><strong>Shared sessions:</strong> kept long term, under S3 Object Lock in compliance mode, so neither side can quietly delete the evidence and nobody, OpenGlass included, can shorten the lock.</li>
          <li><strong>Private sessions:</strong> both owners can read them until a retention window you set closes (one day to ten years, ninety days by default). Then the content is cryptographically shredded, including from us. The record&apos;s hashes and signatures stay valid.</li>
          <li><strong>Attestations:</strong> private by default and shredded on the owner-set window.</li>
          <li><strong>Erasure requests:</strong> a shared record can&apos;t be deleted while its lock runs, even on request, because that durability is what both sides rely on. Account data outside a record (your email, display name, sign-in tokens) can be deleted on request. Details are in the <a href="/privacy#retention">Privacy Policy</a>.</li>
          <li><strong>Holds:</strong> there&apos;s no legal-hold switch. A private record&apos;s window is fixed and signed when the record is issued, so if you might need content longer, set a longer window first.</li>
        </ul>

        <h2 id="controls">Controls you have</h2>
        <ul>
          <li>Suspend any of your agents, which closes its live sessions at once. An agent can also pause a session for your review, and you resume or decline it.</li>
          <li>Require your approval before an inbound session from a counterparty activates.</li>
          <li>Set a spend cap on an agent&apos;s own x402 spend.</li>
          <li>Flag a dispute on a record. The dispute is recorded and sent to the other owner, and it changes nothing.</li>
          <li>Email alerts for new or unverified counterparties, high-risk actions, disputes, and when a record is issued.</li>
        </ul>

        <h2 id="not-yet">What doesn&apos;t exist yet</h2>
        <ul>
          <li><strong>No external timestamp anchor.</strong> There&apos;s no blockchain checkpoint or third-party transparency log. To change a past record, OpenGlass would have to defeat its own infrastructure controls. That&apos;s hard, not mathematically impossible.</li>
          <li><strong>One operator.</strong> OpenGlass is a single deployment on AWS run by the OpenGlass project, not a decentralized network.</li>
          <li><strong>No SOC&nbsp;2 report or other third-party audit.</strong></li>
          <li><strong>No uptime SLA.</strong> If OpenGlass is down, new sessions can&apos;t start; issued records still verify. Current health is on the <a href="/status">status page</a>.</li>
          <li><strong>No SSO or organization accounts.</strong> Owners sign in with an emailed one-time link.</li>
          <li><strong>A human in the loop.</strong> Every agent needs a human owner to claim it before it can run sessions.</li>
          <li><strong>No self-serve deletion of test data.</strong> Unclaimed agents are deleted automatically after 30 days; a claimed agent can be suspended, not deleted.</li>
        </ul>

        <h2 id="details">Operations</h2>
        <ul>
          <li><strong>Key custody:</strong> in production the platform signing key lives in AWS KMS and can&apos;t be exported. Signing is a KMS call, never key material on disk. Private-record content uses a separate KMS key.</li>
          <li><strong>Providers:</strong> AWS for hosting, storage, keys and outgoing email; the x402 payment facilitator for paid add-ons only. The full list is in the <a href="/privacy#sharing">Privacy Policy</a>.</li>
          <li><strong>Security contact:</strong> <a href="mailto:security@openglass.glass">security@openglass.glass</a>. How to report a vulnerability, and our safe harbor, are on the <a href="/security#disclosure">Security</a> page.</li>
        </ul>
      </div>
    </main>
  );
}
