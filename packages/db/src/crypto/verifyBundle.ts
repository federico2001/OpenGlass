import type { Offer, PlatformKey, RecordBundle } from "../models/protocol.js";
import { canonicalizeToBytes } from "./canonicalJson.js";
import { hex, hexToBytes, sha256 } from "./hash.js";
import { base64UrlDecode } from "./ed25519.js";
import { verifySignature, type VerifyingKey } from "./verify.js";

export interface VerifyError {
  code: string;
  seq?: number;
  message: string;
}

export interface VerifyResult {
  valid: boolean;
  errors: VerifyError[];
}

type ParticipantRef = Offer["initiator"]; // { agentId, kid, publicKey }

/**
 * SPEC §7.6. Runs the full independent-verification algorithm: anyone can call this (the
 * SDKs, the web UI, `POST /v1/verify`, and the worker before it issues a record) given a
 * bundle plus a list of trusted platform keys from OUTSIDE the bundle (pinned in the
 * caller or fetched from `/.well-known/openglass-keys.json` over TLS — `bundle.platformKeys`
 * is only a hint and is never trusted on its own).
 *
 * Every check is recorded via `require` and execution continues regardless, so one pass
 * reports every problem rather than stopping at the first failure.
 */
export function verifyBundle(bundle: RecordBundle, trusted: PlatformKey[]): VerifyResult {
  const errors: VerifyError[] = [];
  const require = (condition: boolean, code: string, seq?: number, message = code): void => {
    if (!condition) errors.push({ code, seq, message });
  };

  const E = bundle.evidence;
  const S = bundle.record.statement;

  const keyFromPlatformKey = (k: PlatformKey): VerifyingKey => ({
    alg: k.alg,
    kid: k.kid,
    publicKey: base64UrlDecode(k.publicKey),
  });
  const inWindow = (k: PlatformKey, at: string) => at >= k.validFrom && (k.validUntil === null || at <= k.validUntil);
  const plat = (sig: { kid: string; alg: string }, at: string): VerifyingKey | undefined => {
    const k = trusted.find((tk) => tk.kid === sig.kid && tk.alg === sig.alg && inWindow(tk, at));
    return k ? keyFromPlatformKey(k) : undefined;
  };
  const agentKey = (ref: ParticipantRef): VerifyingKey => ({
    alg: "Ed25519",
    kid: ref.kid,
    publicKey: base64UrlDecode(ref.publicKey),
  });

  // 1. Record statement
  require(hex(sha256(canonicalizeToBytes(S))) === bundle.record.statementHash, "statement_hash");
  require(
    verifySignature(
      plat(bundle.record.platformSignature, S.issuedAt),
      "record",
      hexToBytes(bundle.record.statementHash),
      bundle.record.platformSignature,
    ),
    "record_signature",
  );
  require(hex(sha256(canonicalizeToBytes(E))) === S.evidenceSha256, "evidence_hash");
  require(E.offer.sessionId === S.sessionId && E.offer.mode === S.mode, "session_mismatch");

  // 2. Genesis
  const A = E.offer.initiator;
  const B = E.accept.counterparty;
  require(A.agentId !== B.agentId, "self_session");
  require(E.offerSignature.kid === A.kid && E.acceptSignature.kid === B.kid, "kid_mismatch");

  const offerHashBytes = sha256(canonicalizeToBytes(E.offer));
  require(verifySignature(agentKey(A), "offer", offerHashBytes, E.offerSignature), "offer_signature");
  require(E.accept.offerHash === hex(offerHashBytes), "offer_hash");
  require(E.accept.sessionId === E.offer.sessionId, "session_mismatch");
  require(E.offer.counterparty === null || E.offer.counterparty.agentId === B.agentId, "counterparty_mismatch");
  require(
    verifySignature(agentKey(B), "accept", sha256(canonicalizeToBytes(E.accept)), E.acceptSignature),
    "accept_signature",
  );

  const genesisHashBytes = sha256(
    canonicalizeToBytes({
      offer: E.offer,
      offerSignature: E.offerSignature,
      accept: E.accept,
      acceptSignature: E.acceptSignature,
    }),
  );
  const g = hex(genesisHashBytes);
  require(g === E.genesisHash && g === S.genesisHash, "genesis_hash");
  require(
    verifySignature(plat(E.genesisSignature, E.accept.acceptedAt), "genesis", genesisHashBytes, E.genesisSignature),
    "genesis_signature",
  );
  require(participantsMatch(S.participants, A, B), "participants");

  // 3. Chain
  const keyOf: Record<string, ParticipantRef> = { [A.agentId]: A, [B.agentId]: B };
  let prev = g;
  let lastReceived = E.accept.acceptedAt;
  E.messages.forEach((m, i) => {
    const env = m.envelope;
    const seq = i + 1;
    require(env.v === 1 && env.type === "openglass.message", "envelope_type", seq);
    require(env.sessionId === S.sessionId && env.seq === seq, "seq", seq);
    require(env.prevHash === prev, "prev_hash", seq);

    const k = keyOf[env.sender.agentId];
    require(!!k && env.sender.kid === k.kid && m.signature.kid === k.kid, "sender", seq);

    if (S.mode === "relay") {
      require(env.payloadHash === hex(sha256(canonicalizeToBytes(m.payload))), "payload_hash", seq);
    } else {
      require(!("payload" in m), "payload_present", seq);
    }

    const hBytes = sha256(Buffer.concat([hexToBytes(prev), canonicalizeToBytes(env)]));
    const h = hex(hBytes);
    require(h === m.hash, "hash", seq);
    require(verifySignature(k && agentKey(k), "message", hBytes, m.signature), "message_signature", seq);

    const countersignDigest = sha256(canonicalizeToBytes({ hash: h, agentSig: m.signature.sig, receivedAt: m.receivedAt }));
    require(
      verifySignature(plat(m.platformSignature, m.receivedAt), "countersign", countersignDigest, m.platformSignature),
      "countersignature",
      seq,
    );
    require(m.receivedAt >= lastReceived, "time_order", seq);

    prev = h;
    lastReceived = m.receivedAt;
  });

  // 4. Head and close
  require(S.headSeq === E.messages.length && S.messageCount === E.messages.length, "head_seq");
  require(S.headHash === (E.messages.length ? prev : null), "head_hash");
  if (E.close) {
    const c = E.close.statement;
    const k = S.closedBy ? keyOf[S.closedBy] : undefined;
    require(!!k && c.sessionId === S.sessionId && c.headSeq === S.headSeq && c.headHash === S.headHash, "close_statement");
    require(
      verifySignature(k && agentKey(k), "close", sha256(canonicalizeToBytes(c)), E.close.signature),
      "close_signature",
    );
  } else {
    require(S.closedBy === null, "close_missing");
  }

  return { valid: errors.length === 0, errors };
}

function participantsMatch(
  participants: { role: "initiator" | "counterparty"; agentId: string; kid: string }[],
  a: ParticipantRef,
  b: ParticipantRef,
): boolean {
  const init = participants.find((p) => p.role === "initiator");
  const cp = participants.find((p) => p.role === "counterparty");
  return (
    !!init && !!cp && init.agentId === a.agentId && init.kid === a.kid && cp.agentId === b.agentId && cp.kid === b.kid
  );
}
