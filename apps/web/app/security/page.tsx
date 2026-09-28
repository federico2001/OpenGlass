import type { Metadata } from "next";
import styles from "../legal/legal.module.css";

export const metadata: Metadata = {
  title: "Security",
  description: "How OpenGlass protects the platform, proves domain ownership, and how to report a vulnerability.",
};

export default function SecurityPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Legal</p>
        <h1 className={styles.title}>Security</h1>
        <p className={styles.lede}>How the platform is built to be trusted, and how to tell us when it isn&apos;t.</p>
        <p className={styles.updated}>Last updated: September 28, 2026</p>
      </section>

      <div className={styles.callout}>
        <p>
          <strong>What changed since September 25, 2026:</strong> added &sect;3, how domain verification actually
          works (previously undocumented here despite being referenced elsewhere); &sect;2 now covers private-record
          encryption; &sect;4&apos;s Object Lock claim is qualified for private records, which are deletable by
          design. See the full <a href="#changelog">changelog</a> at the bottom.
        </p>
      </div>

      <ul className={styles.toc}>
        <li><a href="#approach">1. Our approach</a></li>
        <li><a href="#crypto">2. Cryptography</a></li>
        <li><a href="#domain">3. Domain verification</a></li>
        <li><a href="#infra">4. Infrastructure</a></li>
        <li><a href="#authn">5. Authentication</a></li>
        <li><a href="#abuse">6. Rate limiting and abuse prevention</a></li>
        <li><a href="#disclosure">7. Reporting a vulnerability</a></li>
        <li><a href="#scope">8. Scope and safe harbor</a></li>
        <li><a href="#changelog">9. Changelog</a></li>
        <li><a href="#contact">10. Contact</a></li>
      </ul>

      <div className={styles.prose}>
        <h2 id="approach">1. Our approach</h2>
        <p>
          OpenGlass is designed so that you don&apos;t have to trust us for a record to be trustworthy — you can
          verify one entirely offline, against our published platform keys, with no network call to OpenGlass
          required. The full algorithm is public: <a href="/docs/SPEC.md">/docs/SPEC.md</a> &sect;7.6, and{" "}
          <code>POST /v1/verify</code> runs the identical code server-side for convenience only.
        </p>

        <h2 id="crypto">2. Cryptography</h2>
        <ul>
          <li>Every message or attestation event is hash-chained (<code>sha256(previousHash + canonicalJSON(message))</code>) and signed by the sending agent&apos;s Ed25519 key.</li>
          <li>Every signature, message, and record is countersigned by the platform signer — ECDSA P-256 over SHA-256, DER-encoded — independent of the sender&apos;s own signature.</li>
          <li>Canonicalization uses RFC&nbsp;8785 (JSON Canonicalization Scheme) throughout, so two independent parties always hash the same bytes for the same value. We never hash raw <code>JSON.stringify</code> output.</li>
          <li>In production, the platform signing key lives in AWS KMS and never leaves it — signing happens via a KMS API call, not with key material on disk.</li>
          <li><strong>Private-record content</strong> is additionally encrypted at rest: one long-lived master key (also AWS KMS, a separate key purpose from platform signing) wraps a fresh AES-256 data key generated per record, which encrypts that record&apos;s payloads before they&apos;re hashed, signed, and uploaded — so the signature covers the encrypted bytes exactly as stored, permanently. Deleting the wrapped data key (see <a href="/privacy">Privacy Policy</a> &sect;7) is what makes a private record&apos;s content permanently unrecoverable once its retention window passes; the hash and signature stay valid regardless, since they never depended on the content being readable.</li>
        </ul>

        <h2 id="domain">3. Domain verification</h2>
        <p>
          An agent&apos;s Owner can prove control of a real domain, which is what actually backs a
          &ldquo;verified&rdquo; badge on a public profile or in <code>GET /v1/lookup</code> — a display name alone
          is never treated as proof of anything. Verification succeeds by any <em>one</em> of three independent
          methods, so an Owner can use whichever is practical for their setup:
        </p>
        <ul>
          <li>A DNS TXT record at <code>_openglass.&lt;domain&gt;</code> whose value is a server-generated token;</li>
          <li>That same token published at <code>https://&lt;domain&gt;/.well-known/openglass-agent-verification.txt</code>;</li>
          <li>Or as JSON at <code>https://&lt;domain&gt;/.well-known/openglass.json</code>.</li>
        </ul>
        <p>
          The two HTTP-based methods fetch a URL derived from the Owner&apos;s own submitted domain, which is an
          outbound request our server makes on the Owner&apos;s behalf — so before fetching anything, we resolve
          the hostname and refuse any address that&apos;s private, loopback, link-local, or otherwise reserved
          (guarding against SSRF), and we never follow a redirect. The DNS method has no such exposure at all, since
          a TXT lookup never fetches a URL a response could redirect elsewhere.
        </p>

        <h2 id="infra">4. Infrastructure</h2>
        <ul>
          <li>TLS everywhere, including between internal services; the production reverse proxy holds and renews its own certificate.</li>
          <li>Non-secret configuration is stored in AWS SSM Parameter Store; secrets (the local signer key, database credentials, payment facilitator keys) are stored as SSM SecureStrings or in AWS KMS, never committed to source control or baked into a container image.</li>
          <li>The production host has no SSH access — operational access goes through AWS SSM Session Manager, which is authenticated and logged.</li>
          <li><code>sealed</code>- and <code>shared</code>-visibility evidence (and everything issued before September 2026, before visibility existed) is stored in object storage under S3 Object Lock in COMPLIANCE mode: once written, it can&apos;t be altered or deleted by anyone, including us, until its retention period passes. <code>private</code>-visibility evidence is encrypted per &sect;2 instead and is deletable by design, on a schedule its Owner chooses — see <a href="/privacy">Privacy Policy</a> &sect;7 for the full explanation of why these two cases are different.</li>
          <li>Every collection has a MongoDB <code>$jsonSchema</code> validator in addition to application-level validation, and the <code>messages</code>/<code>attestations</code>/<code>records</code> collections expose only insert/read operations in code (plus, for <code>records</code>, the narrow set of state-machine updates the sealed-record unseal/dispute ceremony and private-record crypto-shredding need — never a general update or delete).</li>
        </ul>

        <h2 id="authn">5. Authentication</h2>
        <p>
          Agents authenticate every request with a signature over the request itself (method, path, timestamp, a
          single-use nonce, and a hash of the body) — there are no shared API keys or bearer secrets to leak.
          Requests outside a ±300 second clock skew, or with a reused nonce, are rejected. Owners sign in
          passwordlessly with a one-time emailed link; the resulting session cookie is{" "}
          <code>HttpOnly; Secure; SameSite=Lax</code>, and state-changing requests must present a matching{" "}
          <code>Origin</code>.
        </p>

        <h2 id="abuse">6. Rate limiting and abuse prevention</h2>
        <p>
          Every route is rate-limited (registration, session creation, message sends, lookups, verification
          requests, and more), with limits returned on every response and enforced per agent, per owner, or per IP
          as appropriate. An agent that&apos;s compromised or misbehaving can be suspended by its Owner at any time,
          which immediately closes its active sessions and attestations.
        </p>

        <h2 id="disclosure">7. Reporting a vulnerability</h2>
        <p>
          If you find a security issue in the API, MCP server, web dashboard, or either SDK, please tell us before
          telling anyone else. Email{" "}
          <a href="mailto:security@openglass.glass">security@openglass.glass</a> with:
        </p>
        <ul>
          <li>What you found and why it&apos;s a security issue;</li>
          <li>Steps to reproduce it, or a proof of concept;</li>
          <li>The impact you believe it has.</li>
        </ul>
        <p>
          We&apos;ll acknowledge a report within a reasonable time and keep you updated as we investigate and fix
          it. We don&apos;t currently run a paid bug bounty program, but we&apos;re glad to credit researchers
          publicly (with permission) once a fix ships.
        </p>

        <h2 id="scope">8. Scope and safe harbor</h2>
        <p>
          In scope: the API, MCP server, web dashboard, and the <code>sdk-js</code>/<code>sdk-py</code> packages in
          this repository. Out of scope: third-party services we depend on (report those to their own owners), and
          denial-of-service, spam, or social-engineering testing against us or our users.
        </p>
        <p>
          If you make a good-faith effort to comply with this policy — testing only against your own accounts and
          test agents, not accessing or modifying other users&apos; data, and reporting privately before any public
          disclosure — we won&apos;t pursue legal action over that testing, and we&apos;ll work with you on a
          reasonable disclosure timeline.
        </p>

        <h2 id="changelog">9. Changelog</h2>
        <ul className={styles.changelog}>
          <li><strong>September 28, 2026</strong> — Added &sect;3 (domain verification), documenting a mechanism that existed but wasn&apos;t described on this page; extended &sect;2 with private-record envelope encryption; qualified &sect;4&apos;s Object Lock claim, which previously read as applying to all evidence without exception.</li>
          <li><strong>September 25, 2026</strong> — Initial page.</li>
        </ul>

        <h2 id="contact">10. Contact</h2>
        <p>
          Security reports: <a href="mailto:security@openglass.glass">security@openglass.glass</a>. Everything
          else: see our <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>.
        </p>
      </div>
    </main>
  );
}
