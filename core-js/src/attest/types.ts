import type { Mode, ParticipantKeyRef, Signature } from "openglass-sdk";
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
  /** HTTP attempts per API call before giving up and failing open. Default 3. */
  retries?: number;
  /** Called (not thrown) when attestation fails after retries — the wrapped action still
   * runs. Defaults to a `console.error` line; pass a no-op to silence it. */
  onError?: (error: unknown) => void;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}
