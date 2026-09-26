import type { AgentDoc } from "@openglass/db";
import { keyFingerprint } from "./fingerprint.js";

export function keyView(k: AgentDoc["keys"][number]) {
  return {
    kid: k.kid,
    alg: k.alg,
    publicKey: k.publicKey,
    createdAt: k.createdAt.toISOString(),
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}

export function domainVerificationView(dv: NonNullable<AgentDoc["domainVerification"]>) {
  return {
    domain: dv.domain,
    status: dv.status,
    token: dv.token,
    requestedAt: dv.requestedAt.toISOString(),
    verifiedAt: dv.verifiedAt?.toISOString() ?? null,
  };
}

function isDomainVerified(doc: AgentDoc): boolean {
  return doc.domainVerification?.status === "verified";
}

/** `AgentPublic` (SPEC §8.1): what anyone can see about an agent. */
export function agentPublicView(doc: AgentDoc) {
  const activeKey = doc.keys.find((k) => !k.revokedAt) ?? doc.keys[0]!;
  return {
    id: doc._id,
    name: doc.name,
    description: doc.description,
    meta: doc.meta,
    status: doc.status,
    fingerprint: keyFingerprint(activeKey.publicKey),
    keys: doc.keys.map(keyView),
    createdAt: doc.createdAt.toISOString(),
    claimed: doc.ownerId !== null,
    verifiedBadge: doc.verifiedBadge ?? false,
    domainVerified: isDomainVerified(doc),
  };
}

/** `Agent` (SPEC §8.1): the fuller view returned to the agent itself or its owner.
 * `Agent` is `AgentPublic` plus owner fields (openapi.yaml: `allOf`), so it carries
 * `claimed` too — kept in sync with `agentPublicView` below. `domainVerification` (the
 * full object, including the pending token to publish) is only here, not in the public
 * view — `domainVerified` there is the simplified public signal. */
export function agentFullView(doc: AgentDoc) {
  return {
    id: doc._id,
    name: doc.name,
    description: doc.description,
    meta: doc.meta,
    status: doc.status,
    claimed: doc.ownerId !== null,
    fingerprint: keyFingerprint((doc.keys.find((k) => !k.revokedAt) ?? doc.keys[0]!).publicKey),
    keys: doc.keys.map(keyView),
    createdAt: doc.createdAt.toISOString(),
    verifiedBadge: doc.verifiedBadge ?? false,
    domainVerified: isDomainVerified(doc),
    domainVerification: doc.domainVerification ? domainVerificationView(doc.domainVerification) : null,
    publicDirectory: doc.publicDirectory ?? false,
    ownerId: doc.ownerId,
    claimedAt: doc.claimedAt?.toISOString() ?? null,
    suspendedAt: doc.suspendedAt?.toISOString() ?? null,
    /** Owner-set cap (null = unlimited) and lifetime total on this agent's own x402
     * premium purchases — private to the agent's own/owner's view, like domainVerification. */
    spendLimitUsdCents: doc.spendLimitUsdCents ?? null,
    totalSpendUsdCents: doc.totalSpendUsdCents ?? 0,
  };
}
