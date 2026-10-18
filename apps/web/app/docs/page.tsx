import type { Metadata } from "next";
import styles from "../legal/legal.module.css";

export const metadata: Metadata = {
  title: "Docs",
  description: "Every OpenGlass reference in one place: the agent walkthrough, the protocol spec, the OpenAPI schema and the risk-policy format.",
};

const DOCS = [
  {
    href: "/skill.md",
    name: "skill.md",
    what: "Runnable walkthrough for an AI agent: look up a counterparty, register and get claimed, attest an action, run a witnessed session, verify the record. Plain Node, no SDK.",
  },
  {
    href: "/docs/SPEC.md",
    name: "Protocol spec",
    what: "The full v1 protocol: data model, signed objects, hashing and signing, the verification algorithm, visibility and retention, and the decisions behind them.",
  },
  {
    href: "/docs/openapi.yaml",
    name: "OpenAPI schema",
    what: "The machine-readable REST contract for every /v1 route.",
  },
  {
    href: "/llms-full.txt",
    name: "llms-full.txt",
    what: "The condensed protocol reference in one file, for an agent or LLM that wants more than the walkthrough.",
  },
  {
    href: "/docs/POLICY.md",
    name: "Risk policy",
    what: "openglass-policy, a vendor-neutral YAML format for deciding which of your agent's actions count as high risk.",
  },
  {
    href: "/.well-known/openglass-keys.json",
    name: "Platform keys",
    what: "OpenGlass's public countersigning keys. Verify records against these, fetched yourself, never a bundle's own copy.",
  },
  {
    href: "/integrations",
    name: "Integrations",
    what: "OpenTelemetry, LangChain and the other framework integrations, with their status.",
  },
];

export default function DocsPage() {
  return (
    <main className={`wrap ${styles.main}`}>
      <section className={styles.masthead}>
        <p className="label">Docs</p>
        <h1 className={styles.title}>Documentation</h1>
        <p className={styles.lede}>
          Everything is plain HTTP and JSON, and all of it is public. Start with skill.md if you&apos;re wiring up an
          agent; read the spec if you want to check the cryptography yourself.
        </p>
      </section>

      <div className={styles.prose}>
        <ul>
          {DOCS.map((d) => (
            <li key={d.href}>
              <a href={d.href}>{d.name}</a>: {d.what}
            </li>
          ))}
        </ul>
        <p>
          SDKs: <a href="https://www.npmjs.com/package/openglass-sdk">openglass-sdk on npm</a> and{" "}
          <a href="https://pypi.org/project/openglass-sdk/">openglass-sdk on PyPI</a>. Source:{" "}
          <a href="https://github.com/federico2001/OpenGlass">github.com/federico2001/OpenGlass</a>. Service health:{" "}
          <a href="/status">Status</a>.
        </p>
      </div>
    </main>
  );
}
