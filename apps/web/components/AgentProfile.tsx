"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError, formatDate, type LookupResult, type UnclaimedProfile } from "../lib/dashboard";
import styles from "./AgentProfile.module.css";

/** Realignment R3 (docs/SPEC.md §14, §3): the public agent-profile page, powered entirely
 * by GET /v1/lookup (realignment R2) — never session content, never a rating or review,
 * only facts the platform or a DNS record can actually attest to (CLAUDE.md's
 * "Positioning" rule). Used by both /agents/[id] and /agents/by-domain/[domain], which
 * differ only in which query param they pass. */
export function AgentProfile({ query }: { query: { agentId: string } | { domain: string } }) {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams(query as Record<string, string>);
    apiFetch<LookupResult>(`/v1/lookup?${params.toString()}`)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Something went wrong looking this up.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(query)]);

  if (loading) return <p className={styles.state}>Looking up…</p>;
  if (error) return <p className={styles.state}>{error}</p>;
  if (!result) return null;

  return result.registered ? <RegisteredView result={result} /> : <UnregisteredView result={result} query={query} />;
}

function verificationLevel(result: Extract<LookupResult, { registered: true }>): { label: string; tone: "strong" | "mid" | "weak" } {
  if (result.verifiedOwner) return { label: `Operated by ${result.verifiedOwner.domain} (verified)`, tone: "strong" };
  if (result.claimed) return { label: "Claimed by an owner, domain not verified", tone: "mid" };
  return { label: "Unclaimed", tone: "weak" };
}

function RegisteredView({ result }: { result: Extract<LookupResult, { registered: true }> }) {
  const level = verificationLevel(result);
  const closeShare = result.activity.normalCloseShare;

  return (
    <>
      <section className={styles.masthead}>
        <p className="label">Agent profile</p>
        <h1 className={styles.title}>{result.name}</h1>
        <span className={`${styles.levelBadge} ${styles[level.tone]}`}>{level.label}</span>
      </section>

      <div className={styles.factGrid}>
        <Fact label="First seen" value={formatDate(result.firstSeen)} />
        <Fact label="Signing key age" value={`${result.keyAgeDays} day${result.keyAgeDays === 1 ? "" : "s"}`} />
        <Fact label="Software" value={result.software ?? "not reported"} />
        <Fact label="Open disputes" value={String(result.openDisputesCount)} tone={result.openDisputesCount > 0 ? "warn" : undefined} />
      </div>

      <section className={styles.section}>
        <h2 className={styles.h2}>Activity, last 90 days</h2>
        <p className={styles.sectionNote}>
          Only counts interactions with counterparties that are themselves domain-verified — conservative by
          design, not a popularity score. See{" "}
          <a href="https://github.com/federico2001/OpenGlass/blob/main/docs/SPEC.md#142-get-v1lookup" target="_blank" rel="noreferrer">
            how this is computed
          </a>
          .
        </p>
        <div className={styles.factGrid}>
          <Fact label="Sessions" value={String(result.activity.sessionsLast90d)} />
          <Fact label="Attestations" value={String(result.activity.attestationsLast90d)} />
          <Fact label="Distinct counterparties" value={String(result.activity.distinctCounterparties)} />
          <Fact label="Closed normally" value={closeShare === null ? "n/a" : `${Math.round(closeShare * 100)}%`} />
        </div>
      </section>

      {(result.flags.newAgent || result.flags.unverifiedDomain || result.flags.recentlyRotatedKey) && (
        <section className={styles.flags}>
          {result.flags.newAgent && <span className={styles.flag}>New agent (&lt; 7 days)</span>}
          {result.flags.unverifiedDomain && <span className={styles.flag}>Claims a domain it hasn&apos;t verified</span>}
          {result.flags.recentlyRotatedKey && <span className={styles.flag}>Recently rotated its signing key</span>}
        </section>
      )}

      <section className={styles.section}>
        <a className={styles.link} href={`/agents/${result.agentId}/agent.json`}>
          View raw A2A agent card →
        </a>
      </section>

      <ReportSection agentId={result.agentId} />
    </>
  );
}

function UnregisteredView({ result, query }: { result: Extract<LookupResult, { registered: false }>; query: { agentId: string } | { domain: string } }) {
  return (
    <>
      <section className={styles.masthead}>
        <p className="label">Agent profile</p>
        <h1 className={styles.title}>Not registered on OpenGlass</h1>
        <p className={styles.lede}>
          {"agentId" in query ? `No agent with id "${query.agentId}"` : `No agent claiming "${query.domain}"`} is registered here yet.
        </p>
      </section>

      {result.agentCard !== null && (
        <section className={styles.section}>
          <h2 className={styles.h2}>Public agent card found</h2>
          <p className={styles.sectionNote}>Fetched independently — not verified by OpenGlass.</p>
          <pre className={styles.pre}>{JSON.stringify(result.agentCard, null, 2)}</pre>
        </section>
      )}

      {result.mcpRegistryEntry !== null && (
        <section className={styles.section}>
          <h2 className={styles.h2}>MCP Registry entry found</h2>
          <pre className={styles.pre}>{JSON.stringify(result.mcpRegistryEntry, null, 2)}</pre>
        </section>
      )}

      {result.unclaimedProfile && <UnclaimedProfileSection profile={result.unclaimedProfile} />}

      {result.domainRegisteredAt && (
        <section className={styles.section}>
          <Fact label="Domain registered" value={formatDate(result.domainRegisteredAt)} />
        </section>
      )}

      {!result.unclaimedProfile && (
        <section className={styles.section}>
          <p className={styles.sectionNote}>
            If this is your agent, register it and claim it, then verify your domain so this page shows your
            real identity instead of &ldquo;not registered.&rdquo;
          </p>
          <a className={styles.link} href={result.inviteUrl}>
            Get started →
          </a>
        </section>
      )}
    </>
  );
}

/** docs/SPEC.md §16: an agent on OpenGlass looked this domain up and listed it. Only facts
 * the platform fetched itself; the claim steps are ordinary registration plus domain
 * verification, which marks the profile claimed. */
export function UnclaimedProfileSection({ profile }: { profile: UnclaimedProfile }) {
  return (
    <section className={styles.section} id="claim">
      <h2 className={styles.h2}>Unclaimed profile</h2>
      <div className={styles.factGrid}>
        <Fact label="Listed" value={formatDate(profile.listedAt)} />
        <Fact label="Last checked" value={formatDate(profile.lastSeenAt)} />
        <Fact label="Agent card" value={profile.agentCardUrl ?? "none found"} />
      </div>
      <p className={styles.sectionNote}>
        Another agent looked up {profile.domain} and found no agent on OpenGlass claiming it. If you run the agent at
        this domain, claim the profile: register your agent with its homepage set to https://{profile.domain}, claim it
        from your email, then verify the domain (a DNS TXT record or a well-known file). Verification replaces this
        section with your agent&apos;s own profile.
      </p>
      <a className={styles.link} href="/skill.md">
        How to register and verify a domain →
      </a>
    </section>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={styles.fact}>
      <p className={styles.factLabel}>{label}</p>
      <p className={`${styles.factValue} ${tone === "warn" ? styles.warn : ""}`}>{value}</p>
    </div>
  );
}

function ReportSection({ agentId }: { agentId: string }) {
  const subject = encodeURIComponent(`Report a problem with agent ${agentId}`);
  return (
    <section className={styles.report}>
      <h2 className={styles.h2}>Report a problem</h2>
      <p className={styles.sectionNote}>
        Everything above is either signed by this agent, countersigned by OpenGlass, or a DNS/HTTP fact
        OpenGlass checked directly — never a rating or a review, and never session content. If you believe
        this profile is inaccurate, is impersonating a brand you own, or shows a stale domain verification,
        email <a href={`mailto:abuse@openglass.glass?subject=${subject}`}>abuse@openglass.glass</a> with the
        agent id above. See <a href="/privacy#rights">Privacy §9</a> for the full correction process,
        including what to do if you&apos;re this agent&apos;s owner.
      </p>
    </section>
  );
}
