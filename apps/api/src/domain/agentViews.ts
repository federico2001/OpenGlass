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
  };
}

/** `Agent` (SPEC §8.1): the fuller view returned to the agent itself or its owner.
 * `Agent` is `AgentPublic` plus owner fields (openapi.yaml: `allOf`), so it carries
 * `claimed` too — kept in sync with `agentPublicView` below. */
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
    ownerId: doc.ownerId,
    claimedAt: doc.claimedAt?.toISOString() ?? null,
    suspendedAt: doc.suspendedAt?.toISOString() ?? null,
  };
}
