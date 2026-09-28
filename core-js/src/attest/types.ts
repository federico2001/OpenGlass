import type { Mode, ParticipantKeyRef, Signature, Visibility } from "openglass-sdk";
import type { RiskLevel, RuleMatch } from "../policy/types.js";

/** Mirrors `openglass-sdk`'s internal (not yet part of its public export surface)
 * `AttestationOpen` shape — SPEC §12.3. Duplicated here as a plain type (no runtime
 * logic, so no drift risk beyond a future SDK API change) rather than waiting on an SDK
 * release to re-export it. */
export interface AttestationOpen {
  v: 1;
  type: "openglass.attestation_open";
  attestationId: string;
  mode: Mode;
  purpose: string;
  attestor: ParticipantKeyRef;
  createdAt: string;
}

export interface AttestationCloseStatement {
  v: 1;
  type: "openglass.close";
  sessionId: string;
  headSeq: number;
  headHash: string | null;
  closedAt: string;
}

export interface AttestApiView {
  id: string;
  genesisHash: string;
  head: { seq: number; hash: string | null };
}

export type AttestReason = "below_threshold" | "api_unreachable";

export type AttestResult =
  | { attested: true; attestationId: string; risk: RiskLevel; matches: RuleMatch[] }
  | { attested: false; reason: AttestReason; risk: RiskLevel; matches: RuleMatch[]; error?: unknown };

export interface AttestOptions {
  /** Default `https://openglass.glass`. */
  baseUrl?: string;
  /** The lowest risk level that triggers an attestation. Default `"high"`. */
  minRisk?: RiskLevel;
  /** Default `"notary"` — no event payload leaves this process, only its hash, unless
   * you opt into `"relay"` (which uploads the classified event + verdict as the payload). */
  mode?: Mode;
  idleTimeoutSec?: number;
  /** Realignment R7 (docs/SPEC.md §13). Default `"private"` — explicit here rather than
   * left to the server's own default, so a reader of this option list doesn't have to go
   * check SPEC.md to know what happens when it's omitted. A `"private"` request
   * gracefully degrades to `"sealed"` server-side if content encryption isn't configured. */
  visibility?: Visibility;
  /**
   * Realignment R7: optional counterparty lookup (`openglass-sdk`'s `guard()`) folded
   * into the attested payload alongside the policy verdict — e.g. for a tool call that
   * targets a known other agent. This never blocks or suppresses the attestation itself
   * (attestations are a log of what happened, not a gate on it); it only enriches the
   * record with what was known about the counterparty at the time, the same "tell your
   * owner" spirit `guard()` itself uses. Omit `counterpartyAgentId` to skip this entirely
   * — the common case, since most attested events have no clear single counterparty.
   */
  counterpartyAgentId?: string;
  onUnverifiedDomain?: "allow" | "warn" | "block";
  onNewCounterparty?: "allow" | "warn" | "block";
  /** HTTP attempts per API call before giving up and failing open. Default 3. */
  retries?: number;
  /** Called (not thrown) when attestation fails after retries — the wrapped action still
   * runs. Defaults to a `console.error` line; pass a no-op to silence it. */
  onError?: (error: unknown) => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}
