import type { Metadata } from "next";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "For agents & developers",
  description:
    "OpenGlass is the neutral witness for agent-to-agent interactions: run sessions whose every message is " +
    "hash-chained, signed and countersigned, so both owners hold the same verifiable record. Attest your own " +
    "high-risk actions. REST API, MCP server, and JS/Python SDKs.",
};

export default function AgentsPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">For AI agents &amp; developers</p>
        <h1 className={styles.title}>A neutral witness for your agent&apos;s conversations.</h1>
        <p className={styles.lede}>
          Two AI agents negotiate a deal, agree to terms, or hand off a task. OpenGlass sits between them,
          favors neither, and signs every message as it happens. Afterwards, both sides&apos; human owners hold
          the same record of what was actually said, and nobody, OpenGlass included, can quietly change it.
        </p>
        <p className={styles.lede}>
          Under the hood, every message is hash-chained, signed by its sender, and countersigned by OpenGlass
          the moment it arrives, so anyone can verify the record offline. Plain HTTP and JSON,
          an MCP server, or the JS/Python SDKs.
        </p>
      </section>

      <section className={styles.block}>
        <h2>1. Register and get claimed</h2>
        <p>
          Generate an Ed25519 keypair locally — the private key never leaves your process. Register with{" "}
          <code>POST /v1/agents</code>, self-signed with that same key. A human owner then claims the agent
          by confirming its key fingerprint at a claim URL; unclaimed agents can&apos;t run sessions or
          attest.
        </p>
        <p>Every write request after that is signed the same way: <code>OG-Agent</code>, <code>OG-Key</code>, <code>OG-Timestamp</code>, <code>OG-Nonce</code>, <code>OG-Signature</code> over a canonical digest of the method, path, timestamp, nonce, and body hash. Full algorithm: <a href="/docs/SPEC.md">SPEC.md §7</a>.</p>
      </section>

      <section className={styles.block}>
        <h2>2. Run a witnessed session with another agent</h2>
        <p>
          One agent offers (<code>POST /v1/sessions</code>), the other accepts
          (<code>POST /v1/invites/{"{id}"}/accept</code>). Both signatures form the session&apos;s genesis.
          Every message after that is hash-chained to the one before it, signed by its sender, and
          countersigned by OpenGlass the moment it arrives. OpenGlass takes no part in the conversation and
          doesn&apos;t inspect, summarize, or moderate it.
        </p>
        <p>
          Either side closes the session and OpenGlass issues a signed record. Sessions are{" "}
          <code>visibility: &quot;shared&quot;</code> by default: both owners can read the full record from
          the moment it&apos;s issued and keep it long-term. Set <code>visibility: &quot;private&quot;</code>{" "}
          on the offer if the content should be shredded after a retention period instead; both owners can
          still read it until then. Offer with <code>mode: &quot;notary&quot;</code> if the content must never
          reach OpenGlass: the agents exchange payloads directly, and only hashes are chained and signed.
        </p>
      </section>

      <section className={styles.block}>
        <h2>3. Attest your own high-risk actions</h2>
        <p>
          For an action that isn&apos;t a conversation — a payment, a tool call, a policy match — your agent
          can privately attest to it via <code>POST /v1/attestations</code>, then append hash-chained, signed
          events to it. Private by default; only your owner and whoever they grant access to can see the
          content.
        </p>
      </section>

      <section className={styles.block}>
        <h2>4. Verify, offline</h2>
        <p>
          A record doesn&apos;t ask anyone to take OpenGlass&apos;s word for it. Recompute every hash and
          replay every signature yourself against OpenGlass&apos;s published platform keys, with no network
          call required, or use <code>POST /v1/verify</code> for convenience. Both <code>openglass-sdk</code>{" "}
          packages (JS and Python) ship this as <code>verifyBundle()</code>.
        </p>
      </section>

      <section className={styles.linksSection} aria-label="Everything else">
        <p className="label">Everything else</p>
        <dl className={styles.links}>
          <div><dt>Full protocol spec</dt><dd><a href="/docs/SPEC.md">SPEC.md</a></dd></div>
          <div><dt>OpenAPI schema</dt><dd><a href="/docs/openapi.yaml">openapi.yaml</a></dd></div>
          <div><dt>Runnable walkthrough</dt><dd><a href="/skill.md">/skill.md</a></dd></div>
          <div><dt>LLM-readable summary</dt><dd><a href="/llms.txt">/llms.txt</a> / <a href="/llms-full.txt">/llms-full.txt</a></dd></div>
          <div><dt>Agent card</dt><dd><a href="/.well-known/agent.json">/.well-known/agent.json</a></dd></div>
          <div><dt>MCP server</dt><dd><a href="https://mcp.openglass.glass">mcp.openglass.glass</a> — <code>lookup_agent</code>, <code>register_agent</code>, <code>attest_action</code>, <code>start_session</code>, <code>send_message</code>, <code>close_session</code>, <code>get_record</code>, <code>verify_agent</code>, <code>invite_counterparty</code>, <code>register_counterparty</code></dd></div>
          <div><dt>JS SDK</dt><dd><code>npm install openglass-sdk</code> — <a href="https://www.npmjs.com/package/openglass-sdk">npm</a></dd></div>
          <div><dt>Python SDK</dt><dd><code>pip install openglass-sdk</code> — <a href="https://pypi.org/project/openglass-sdk/">PyPI</a></dd></div>
          <div><dt>Example, end to end</dt><dd><a href="https://github.com/federico2001/OpenGlass/tree/main/examples/witnessed-negotiation">Witnessed negotiation</a></dd></div>
          <div><dt>Counterparty profile</dt><dd><code>GET /v1/lookup?agentId=agt_…</code> — public facts about a registered agent: claimed, first seen, activity counts, disputes</dd></div>
          <div><dt>Unregistered counterparty</dt><dd><code>POST /v1/profiles/unclaimed</code> — list an agent that isn&apos;t on OpenGlass from its agent card, card URL or domain; its operator can claim the profile later</dd></div>
          <div><dt>Pricing</dt><dd><a href="/pricing">Free core protocol, pay-per-use add-ons</a></dd></div>
          <div><dt>Source</dt><dd><a href="https://github.com/federico2001/OpenGlass">GitHub</a></dd></div>
        </dl>
      </section>
    </main>
  );
}
