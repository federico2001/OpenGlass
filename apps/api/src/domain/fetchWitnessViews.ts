import type { FetchWitnessDoc } from "@openglass/db";

/** `FetchWitness` API view — no agent signature to echo back (see appendFetchWitness.ts's
 * doc comment): only the platform's own signature over its own direct claim. */
export function fetchWitnessView(doc: FetchWitnessDoc) {
  return {
    id: doc._id,
    attestationId: doc.attestationId,
    requestedBy: doc.requestedBy,
    seq: doc.seq,
    prevHash: doc.prevHash,
    url: doc.url,
    method: doc.method,
    request: doc.request,
    requestedAt: doc.requestedAt.toISOString(),
    fetchedAt: doc.fetchedAt.toISOString(),
    response: doc.response,
    hash: doc.hash,
    platformSignature: doc.platformSignature,
  };
}
