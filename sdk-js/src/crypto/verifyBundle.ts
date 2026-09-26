import type { Offer, PlatformKey, RecordBundle } from "../types.js";
import { canonicalizeToBytes } from "./canonicalJson.js";
import { base64UrlDecode } from "./ed25519.js";
import { hex, hexToBytes, sha256 } from "./hash.js";
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
 * SPEC §7.6 / §12, ported from `packages/db/src/crypto/verifyBundle.ts`. Runs the full
 * independent-verification algorithm offline — no network access, no trusting OpenGlass's
 * word for anything. `trusted` is a list of platform keys from OUTSIDE the bundle: pin them
 * yourself, or fetch `{apiUrl}/.well-known/openglass-keys.json` over TLS.
 * `bundle.platformKeys` is only a hint and is never trusted on its own.
 *
 * Handles both `statement.kind` values (`"session"` — the default, for every record issued
 * before `kind` existed — and `"attestation"`). Only step 2 (genesis) actually differs;
 * steps 1, 3, 4 are kind-agnostic by construction — see the field-reuse notes in
 * packages/db/src/models/protocol.ts.
 *
 * Every check is recorded and execution continues regardless, so one pass reports every
 * problem rather than stopping at the first failure.
 */
export function verifyBundle(bundle: RecordBundle, trusted: PlatformKey[]): VerifyResult {
  const errors: VerifyError[] = [];
  const require = (condition: boolean, code: string, seq?: number, message = code): void => {
    if (!condition) errors.push({ code, seq, message });
  };

  const E = bundle.evidence;
  const S = bundle.record.statement;
  const kind = S.kind ?? "session";

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
  require(kind === "session" ? E.offer !== null : E.open !== null, "kind_mismatch");

  // 2. Genesis — the one step that actually differs by kind.
  let genesisHashBytes: Uint8Array;
  let keyOf: Record<string, ParticipantRef>;
  let genesisAt: string;

  if (kind === "session") {
    const offer = E.offer!;
    const accept = E.accept!;
    const offerSignature = E.offerSignature!;
    const acceptSignature = E.acceptSignature!;
    require(offer.sessionId === S.sessionId && offer.mode === S.mode, "session_mismatch");

    const A = offer.initiator;
    const B = accept.counterparty;
    require(A.agentId !== B.agentId, "self_session");
    require(offerSignature.kid === A.kid && acceptSignature.kid === B.kid, "kid_mismatch");

    const offerHashBytes = sha256(canonicalizeToBytes(offer));
    require(verifySignature(agentKey(A), "offer", offerHashBytes, offerSignature), "offer_signature");
    require(accept.offerHash === hex(offerHashBytes), "offer_hash");
    require(accept.sessionId === offer.sessionId, "session_mismatch");
    require(offer.counterparty === null || offer.counterparty.agentId === B.agentId, "counterparty_mismatch");
    require(verifySignature(agentKey(B), "accept", sha256(canonicalizeToBytes(accept)), acceptSignature), "accept_signature");

    genesisHashBytes = sha256(canonicalizeToBytes({ offer, offerSignature, accept, acceptSignature }));
    genesisAt = accept.acceptedAt;
    keyOf = { [A.agentId]: A, [B.agentId]: B };
    require(participantsMatch(S.participants, A, B), "participants");
  } else {
    const open = E.open!;
    const openSignature = E.openSignature!;
    require(open.attestationId === S.sessionId && open.mode === S.mode, "session_mismatch");

    const A = open.attestor;
    require(openSignature.kid === A.kid, "kid_mismatch");
    require(verifySignature(agentKey(A), "attestation_open", sha256(canonicalizeToBytes(open)), openSignature), "open_signature");

    genesisHashBytes = sha256(canonicalizeToBytes({ open, openSignature }));
    genesisAt = open.createdAt;
    keyOf = { [A.agentId]: A };
    require(attestorMatches(S.participants, A), "participants");
  }

  const g = hex(genesisHashBytes);
  require(g === E.genesisHash && g === S.genesisHash, "genesis_hash");
  require(verifySignature(plat(E.genesisSignature, genesisAt), "genesis", genesisHashBytes, E.genesisSignature), "genesis_signature");

  // 3. Chain — identical for both kinds; operates on the generic `prev`/`keyOf` from step 2.
  let prev = g;
  let lastReceived = genesisAt;
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

    const hBytes = sha256(concatBytes(hexToBytes(prev), canonicalizeToBytes(env)));
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

  // 4. Head and close — identical for both kinds.
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function participantsMatch(
  participants: { role: "initiator" | "counterparty" | "attestor"; agentId: string; kid: string }[],
  a: ParticipantRef,
  b: ParticipantRef,
): boolean {
  const init = participants.find((p) => p.role === "initiator");
  const cp = participants.find((p) => p.role === "counterparty");
  return (
    !!init && !!cp && init.agentId === a.agentId && init.kid === a.kid && cp.agentId === b.agentId && cp.kid === b.kid
  );
}

function attestorMatches(
  participants: { role: "initiator" | "counterparty" | "attestor"; agentId: string; kid: string }[],
  a: ParticipantRef,
): boolean {
  const att = participants.find((p) => p.role === "attestor");
  return !!att && att.agentId === a.agentId && att.kid === a.kid;
}
