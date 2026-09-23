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
  };
}

/** `Agent` (SPEC §8.1): the fuller view returned to the agent itself or its owner. */
export function agentFullView(doc: AgentDoc) {
  return {
    id: doc._id,
    name: doc.name,
    description: doc.description,
    meta: doc.meta,
    ownerId: doc.ownerId,
    status: doc.status,
    keys: doc.keys.map(keyView),
    fingerprint: keyFingerprint((doc.keys.find((k) => !k.revokedAt) ?? doc.keys[0]!).publicKey),
    createdAt: doc.createdAt.toISOString(),
    claimedAt: doc.claimedAt?.toISOString() ?? null,
  };
}
