import { generateKeyPairSync } from "node:crypto";
import {
  agentsRepository,
  base64UrlEncode,
  canonicalizeToBytes,
  generateEd25519KeyPair,
  hex,
  hexToBytes,
  insertMessage,
  LocalSigner,
  newId,
  ownersRepository,
  sessionsRepository,
  sha256,
  signEd25519,
  sigInput,
  type AgentDoc,
  type MessageDoc,
  type OwnerDoc,
  type PlatformSigner,
  type SessionDoc,
} from "@openglass/db";
import type { Db } from "mongodb";

export function testSigner(): PlatformSigner {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return new LocalSigner("plat_test", privateKey);
}

interface Party {
  agentId: string;
  kid: string;
  publicKey: string;
  privateKey: Uint8Array;
  ownerId: string;
}

async function insertClaimedAgent(db: Db, name: string): Promise<Party> {
  const { privateKey, publicKey: rawPublicKey } = generateEd25519KeyPair();
  const publicKey = base64UrlEncode(rawPublicKey);
  const agentId = newId("agt");
  const kid = newId("key");
  const ownerId = newId("own");
  const now = new Date();
  await ownersRepository(db).insert({
    _id: ownerId,
    email: `${name}@example.com`,
    displayName: null,
    settings: { requireInviteApproval: false, emailOnRecord: true },
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });
  await agentsRepository(db).insert({
    _id: agentId,
    name,
    description: "",
    meta: {},
    keys: [{ kid, alg: "Ed25519", publicKey, createdAt: now, revokedAt: null }],
    ownerId,
    status: "active",
    claim: null,
    claimedAt: now,
    suspendedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { agentId, kid, publicKey, privateKey, ownerId };
}

/** Inserts a fully valid, real-crypto ACTIVE session (offer/accept/genesis all genuinely
 * signed) directly via the repositories — worker jobs never go through HTTP. */
export async function buildActiveSession(
  db: Db,
  opts: { signer: PlatformSigner; messageCount?: number; idleTimeoutSec?: number },
): Promise<{ session: SessionDoc; initiator: Party; counterparty: Party; messages: MessageDoc[] }> {
  const initiator = await insertClaimedAgent(db, `init_${newId("agt").slice(-8)}`);
  const counterparty = await insertClaimedAgent(db, `cp_${newId("agt").slice(-8)}`);
  const sessionId = newId("ses");
  const now = new Date();
  const iso = (offsetMs = 0) => new Date(now.getTime() + offsetMs).toISOString();

  const offer = {
    v: 1 as const,
    type: "openglass.offer" as const,
    sessionId,
    mode: "relay" as const,
    purpose: "Test session",
    initiator: { agentId: initiator.agentId, kid: initiator.kid, publicKey: initiator.publicKey },
    counterparty: { agentId: counterparty.agentId },
    idleTimeoutSec: opts.idleTimeoutSec ?? 86400,
    createdAt: iso(),
    expiresAt: iso(86_400_000),
  };
  const offerSignature = {
    alg: "Ed25519" as const,
    kid: initiator.kid,
    sig: base64UrlEncode(signEd25519(sigInput("offer", sha256(canonicalizeToBytes(offer))), initiator.privateKey)),
  };

  const accept = {
    v: 1 as const,
    type: "openglass.accept" as const,
    sessionId,
    offerHash: hex(sha256(canonicalizeToBytes(offer))),
    counterparty: { agentId: counterparty.agentId, kid: counterparty.kid, publicKey: counterparty.publicKey },
    acceptedAt: iso(1000),
  };
  const acceptSignature = {
    alg: "Ed25519" as const,
    kid: counterparty.kid,
    sig: base64UrlEncode(signEd25519(sigInput("accept", sha256(canonicalizeToBytes(accept))), counterparty.privateKey)),
  };

  const genesisHashBytes = sha256(canonicalizeToBytes({ offer, offerSignature, accept, acceptSignature }));
  const genesisHash = hex(genesisHashBytes);
  const genesisSignature = await opts.signer.sign("genesis", genesisHashBytes);

  const sessionDoc: SessionDoc = {
    _id: sessionId,
    mode: "relay",
    status: "active",
    purpose: offer.purpose,
    initiator: { agentId: initiator.agentId, ownerId: initiator.ownerId, kid: initiator.kid },
    counterparty: { agentId: counterparty.agentId, ownerId: counterparty.ownerId, kid: counterparty.kid },
    inviteId: newId("inv"),
    offer,
    offerSignature,
    accept,
    acceptSignature,
    genesisHash,
    genesisSignature,
    head: { seq: 0, hash: null },
    messageCount: 0,
    idleTimeoutSec: offer.idleTimeoutSec,
    createdAt: now,
    activatedAt: now,
    lastActivityAt: now,
    expiresAt: new Date(now.getTime() + offer.idleTimeoutSec * 1000),
    pause: null,
    closing: null,
    closedAt: null,
    recordId: null,
  };

  const messages: MessageDoc[] = [];
  let prevHash = genesisHash;
  const count = opts.messageCount ?? 0;
  for (let i = 1; i <= count; i++) {
    const sender = i % 2 === 1 ? initiator : counterparty;
    const payload = { text: `message ${i}` };
    const payloadHash = hex(sha256(canonicalizeToBytes(payload)));
    const envelope = {
      v: 1 as const,
      type: "openglass.message" as const,
      sessionId,
      seq: i,
      prevHash,
      sender: { agentId: sender.agentId, kid: sender.kid },
      contentType: "application/json",
      payloadHash,
      sentAt: iso(2000 + i),
    };
    const hashBytes = sha256(Buffer.concat([hexToBytes(prevHash), canonicalizeToBytes(envelope)]));
    const hash = hex(hashBytes);
    const signature = { alg: "Ed25519" as const, kid: sender.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), sender.privateKey)) };
    const receivedAt = new Date(now.getTime() + 2000 + i);
    const countersignDigest = sha256(canonicalizeToBytes({ hash, agentSig: signature.sig, receivedAt: receivedAt.toISOString() }));
    const platformSignature = await opts.signer.sign("countersign", countersignDigest);
    const messageDoc: MessageDoc = { _id: newId("msg"), sessionId, seq: i, envelope, hash, signature, receivedAt, platformSignature, payload };
    await insertMessage(db, messageDoc);
    messages.push(messageDoc);
    prevHash = hash;
    sessionDoc.head = { seq: i, hash };
    sessionDoc.messageCount = i;
  }

  await sessionsRepository(db).insert(sessionDoc);
  return { session: sessionDoc, initiator, counterparty, messages };
}

export type { AgentDoc, OwnerDoc, Party };
