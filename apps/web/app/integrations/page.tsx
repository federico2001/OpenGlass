import type { Metadata } from "next";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Where OpenGlass works",
  description:
    "Where OpenGlass can be used today: the Claude connector directory, the ChatGPT plugin directory, remote MCP " +
    "clients, the JavaScript and Python SDKs, and plain HTTP. Plus OpenTelemetry and LangChain source adapters in the repo.",
};

const REPO = "https://github.com/federico2001/OpenGlass";

interface Entry {
  name: string;
  what: React.ReactNode;
  links: { label: string; href: string }[];
  command?: string;
}

const AVAILABLE: Entry[] = [
  {
    name: "Claude connector directory",
    what: "Listed as a community connector with the public lookup and verify tools. Adding it needs a Claude account; no OpenGlass account.",
    links: [{ label: "claude.ai/directory/openglass", href: "https://claude.ai/directory/openglass" }],
  },
  {
    name: "ChatGPT plugin directory",
    what: "The same public lookup and verify tools. Installing it needs a ChatGPT account; no OpenGlass account.",
    links: [{ label: "OpenGlass in the ChatGPT plugin directory", href: "https://chatgpt.com/plugins/plugin_asdk_app_6af7448d3e208191914d5f80f658ce87" }],
  },
  {
    name: "MCP clients with remote streamable-HTTP support",
    what: (
      <>
        Point a client that supports remote MCP servers at the public endpoint, which serves the tools that need no
        signing. The full server at <code>/mcp</code> needs each write request signed with your agent&apos;s key (
        <a href="/docs/SPEC.md">SPEC.md</a>, request signing). Listed on the official MCP Registry as{" "}
        <code>io.github.federico2001/openglass-mcp</code>. Support for remote servers varies by client.
      </>
    ),
    command: "https://mcp.openglass.glass/mcp-public",
    links: [
      { label: "MCP Registry entry", href: "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.federico2001/openglass-mcp" },
    ],
  },
  {
    name: "JavaScript / TypeScript SDK",
    what: "Register an agent, run witnessed sessions, attest actions and verify records from Node or the browser.",
    command: "npm install openglass-sdk",
    links: [{ label: "npm", href: "https://www.npmjs.com/package/openglass-sdk" }],
  },
  {
    name: "Python SDK",
    what: "The same operations from Python.",
    command: "pip install openglass-sdk",
    links: [{ label: "PyPI", href: "https://pypi.org/project/openglass-sdk/" }],
  },
  {
    name: "Direct HTTP, no SDK",
    what: "The protocol is plain HTTP and JSON, documented in public.",
    links: [
      { label: "Spec", href: "/docs/SPEC.md" },
      { label: "OpenAPI schema", href: "/docs/openapi.yaml" },
      { label: "Agent card", href: "/.well-known/agent.json" },
    ],
  },
];

const SOURCE: Entry[] = [
  {
    name: "OpenTelemetry (otel-js, otel-py)",
    what: "SpanProcessor adapters that read GenAI spans and open attestations for the ones a policy flags, with an example.",
    links: [
      { label: "otel-js", href: `${REPO}/tree/main/otel-js` },
      { label: "otel-py", href: `${REPO}/tree/main/otel-py` },
      { label: "examples/otel-integration", href: `${REPO}/tree/main/examples/otel-integration` },
    ],
  },
  {
    name: "LangChain, Python (langchain-py)",
    what: "A BaseCallbackHandler adapter that opens attestations for the tool calls a policy flags, with an example.",
    links: [
      { label: "langchain-py", href: `${REPO}/tree/main/langchain-py` },
      { label: "examples/langchain-integration", href: `${REPO}/tree/main/examples/langchain-integration` },
    ],
  },
];

function List({ entries }: { entries: Entry[] }) {
  return (
    <ul className={styles.list}>
      {entries.map((e) => (
        <li key={e.name} className={styles.item}>
          <h3 className={styles.name}>{e.name}</h3>
          <p className={styles.desc}>{e.what}</p>
          {e.command && <pre className={styles.command}>{e.command}</pre>}
          <p className={styles.links}>
            {e.links.map((l) => (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ))}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default function IntegrationsPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Integrations</p>
        <h1 className={styles.title}>Where OpenGlass works</h1>
        <p className={styles.lede}>
          Where you can use OpenGlass today, and what each option gives you. The public tools need no OpenGlass
          account.
        </p>
      </section>

      <section className={styles.group} aria-labelledby="available">
        <h2 id="available" className={styles.groupTitle}>
          Available now
        </h2>
        <List entries={AVAILABLE} />
      </section>

      <section className={styles.group} aria-labelledby="source">
        <h2 id="source" className={styles.groupTitle}>
          Source adapters in the repo
        </h2>
        <p className={styles.caveat}>Source adapters and examples in the repo; package publication and installation support not confirmed.</p>
        <List entries={SOURCE} />
      </section>

      <p className={styles.footnote}>
        Missing a framework or client? Open an issue: <a href={`${REPO}/issues`}>github.com/federico2001/OpenGlass/issues</a>
      </p>
    </main>
  );
}
