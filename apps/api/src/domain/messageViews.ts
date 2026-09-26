import type { MessageDoc } from "@openglass/db";

/** `Message` (SPEC §8.2 API view) — shared by the REST route and the WS hub so a message
 * looks identical whichever transport delivered it. */
export function messageView(doc: MessageDoc) {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    seq: doc.seq,
    envelope: doc.envelope,
    hash: doc.hash,
    signature: doc.signature,
    receivedAt: doc.receivedAt.toISOString(),
    platformSignature: doc.platformSignature,
    ...("payload" in doc ? { payload: doc.payload } : {}),
  };
}
