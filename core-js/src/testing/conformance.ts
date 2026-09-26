import type { AttestResult } from "../attest/types.js";

/**
 * The contract every OpenGlass integration must satisfy (SPEC/openglass-policy README's
 * "vendor-neutral, pluggable backend" goal, applied to the integration layer itself):
 * given one native framework event (a span, a callback payload, whatever the framework
 * hands you), the integration extracts a `PolicyEvent`, evaluates it, and calls
 * `evaluateAndAttest` — end to end, exactly the way it would in production, just with a
 * transport double instead of a real server.
 */
export interface ConformanceHarness {
  process(nativeEvent: unknown): Promise<AttestResult>;
}

export interface ConformanceFixtures {
  /** A native event the integration's own default-policy-equivalent mapping should
   * classify as high risk (e.g., a "transfer_funds" tool call). */
  highRisk: unknown;
  /** A native event that should fall through to the default (low) risk. */
  lowRisk: unknown;
}

function fail(check: string, detail: string): never {
  throw new Error(`openglass-core conformance: ${check} — ${detail}`);
}

export async function assertAttestsHighRisk(harness: ConformanceHarness, fixtures: ConformanceFixtures): Promise<void> {
  const result = await harness.process(fixtures.highRisk);
  if (!result.attested) fail("assertAttestsHighRisk", `expected an attestation, got ${JSON.stringify(result)}`);
}

export async function assertSkipsLowRisk(harness: ConformanceHarness, fixtures: ConformanceFixtures): Promise<void> {
  const result = await harness.process(fixtures.lowRisk);
  if (result.attested) fail("assertSkipsLowRisk", `expected no attestation, got ${JSON.stringify(result)}`);
  if (result.reason !== "below_threshold") fail("assertSkipsLowRisk", `expected reason "below_threshold", got "${result.reason}"`);
}

/** The harness passed here must be wired to a transport that always fails (see
 * openglass-otel's own test suite for the pattern: an `evaluateAndAttest` call with a
 * `fetchImpl` that always rejects). Confirms the integration never throws and never
 * blocks on an unreachable API. */
export async function assertFailsOpenOnApiError(harness: ConformanceHarness, fixtures: ConformanceFixtures): Promise<void> {
  const result = await harness.process(fixtures.highRisk);
  if (result.attested) fail("assertFailsOpenOnApiError", "expected the (simulated) API failure to prevent attestation");
  if (result.reason !== "api_unreachable") fail("assertFailsOpenOnApiError", `expected reason "api_unreachable", got "${result.reason}"`);
}

/** Runs every conformance check in sequence, so an integration's test file can call
 * `await runAllConformanceChecks(harness, fixtures)` in one `it()` and get a single
 * failure message naming exactly which check failed, or wrap each function individually
 * for per-check test reporting. */
export async function runAllConformanceChecks(harness: ConformanceHarness, fixtures: ConformanceFixtures): Promise<void> {
  await assertAttestsHighRisk(harness, fixtures);
  await assertSkipsLowRisk(harness, fixtures);
}
