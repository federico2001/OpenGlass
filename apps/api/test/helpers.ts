import { randomBytes, generateKeyPairSync } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import {
  agentsRepository,
  base64UrlEncode,
  canonicalizeToBytes,
  generateEd25519KeyPair,
  hex,
  LocalSigner,
  newId,
  ownersRepository,
  sha256,
  signEd25519,
  sigInput,
  webSessionsRepository,
  type Accept,
  type MessageEnvelope,
  type Offer,
  type OwnerDoc,
  type PlatformSigner,
  type Signature,
} from "@openglass/db";
import type { Db, MongoClient } from "mongodb";
import { hashToken } from "../src/domain/tokens.js";
import { createCapturingMailer, type Mailer } from "../src/mailer.js";
import type { ServerDeps } from "../src/server.js";

/** A real (throwaway) local platform signer — genuine ECDSA P-256 signing, not a mock —
 * so route tests exercise the same code path production uses. */
export function testSigner(): PlatformSigner {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return new LocalSigner("plat_test", privateKey);
}

/** Everything `buildServer` needs besides `healthChecks`, wired to a test database.
 * `s3`/`s3Bucket` are only exercised by the record-bundle route and the worker (M5/M6) —
 * route tests here that don't touch those don't need a reachable endpoint. */
export function testServerDeps(
  conn: { db: Db; client: MongoClient },
  s3?: { client: S3Client; bucket: string },
): Omit<ServerDeps, "healthChecks"> & { mailer: Mailer & { sent: unknown[] } } {
  return {
    db: conn.db,
    mongoClient: conn.client,
    signer: testSigner(),
    mailer: createCapturingMailer(),
    publicUrl: "https://localhost",
    webOrigin: "https://localhost",
    s3: s3?.client ?? new S3Client({ endpoint: "http://127.0.0.1:1", region: "us-east-1", forcePathStyle: true }),
    s3Bucket: s3?.bucket ?? "test-bucket",
  };
}

export interface TestAgentIdentity {
  agentId: string;
  kid: string;
  publicKey: string;
  privateKey: Uint8Array;
}

/** A fresh Ed25519 identity for a test "agent" — real keys, real signatures, not fixtures. */
export function testIdentity(agentId: string, kid: string): TestAgentIdentity {
  const { privateKey, publicKey } = generateEd25519KeyPair();
  return { agentId, kid, publicKey: base64UrlEncode(publicKey), privateKey };
}

/**
 * Builds real `OG-*` signed-request headers (SPEC §4.1) for an `app.inject()` call.
 * `selfSigned: true` omits `OG-Agent` (registration path, verified against body.publicKey).
 */
export function signedRequestHeaders(opts: {
  method: string;
  path: string;
  body?: unknown;
  identity: TestAgentIdentity;
  selfSigned?: boolean;
}): Record<string, string> {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const rawBody = opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body), "utf8");
  const bodySha256 = hex(sha256(rawBody));
  const digest = sha256(canonicalizeToBytes({ method: opts.method, path: opts.path, timestamp, nonce, bodySha256 }));
  const sig = base64UrlEncode(signEd25519(sigInput("request", digest), opts.identity.privateKey));
  return {
    ...(opts.selfSigned ? {} : { "og-agent": opts.identity.agentId }),
    "og-key": opts.selfSigned ? "new" : opts.identity.kid,
    "og-timestamp": timestamp,
    "og-nonce": nonce,
    "og-signature": sig,
    "content-type": "application/json",
  };
}

/** Creates a `web_sessions` row directly (bypassing the magic-link email round trip) and
 * returns the `Cookie` header value a test can attach to `app.inject()`. */
export async function createOwnerSessionCookie(db: Db, ownerId: string): Promise<string> {
  const webSessions = webSessionsRepository(db);
  const token = randomBytes(32).toString("base64url");
  await webSessions.insert({
    _id: hashToken(token),
    ownerId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
  });
  return `og_session=${token}`;
}

/** Marks an already-registered agent as claimed by `ownerId`, bypassing the HTTP claim
 * flow — for tests where claiming isn't what's under test. */
export async function claimAgentDirectly(db: Db, agentId: string, ownerId: string): Promise<void> {
  await agentsRepository(db).update(agentId, { status: "active", ownerId, claim: null, claimedAt: new Date() });
}

function signPurpose(privateKey: Uint8Array, purpose: string, obj: unknown): string {
  return base64UrlEncode(signEd25519(sigInput(purpose, sha256(canonicalizeToBytes(obj))), privateKey));
}

/** A well-formed, signed `Offer` (SPEC §7.2), ready to POST to /v1/sessions. */
export function buildOffer(opts: {
  sessionId: string;
  initiator: TestAgentIdentity;
  counterpartyAgentId?: string | null;
  mode?: "relay" | "notary";
  purpose?: string;
  idleTimeoutSec?: number;
  createdAtOffsetMs?: number;
  expiresAtOffsetMs?: number;
}): { offer: Offer; offerSignature: Signature } {
  const createdAt = new Date(Date.now() + (opts.createdAtOffsetMs ?? 0)).toISOString();
  const expiresAt = new Date(Date.now() + (opts.expiresAtOffsetMs ?? 86_400_000)).toISOString();
  const offer: Offer = {
    v: 1,
    type: "openglass.offer",
    sessionId: opts.sessionId,
    mode: opts.mode ?? "relay",
    purpose: opts.purpose ?? "Test session",
    initiator: { agentId: opts.initiator.agentId, kid: opts.initiator.kid, publicKey: opts.initiator.publicKey },
    counterparty: opts.counterpartyAgentId ? { agentId: opts.counterpartyAgentId } : null,
    idleTimeoutSec: opts.idleTimeoutSec ?? 86400,
    createdAt,
    expiresAt,
  };
  const offerSignature: Signature = { alg: "Ed25519", kid: opts.initiator.kid, sig: signPurpose(opts.initiator.privateKey, "offer", offer) };
  return { offer, offerSignature };
}

/** A well-formed, signed `Accept` (SPEC §7.2), ready to POST to /v1/invites/{id}/accept. */
export function buildAccept(opts: {
  offer: Offer;
  counterparty: TestAgentIdentity;
  acceptedAtOffsetMs?: number;
}): { accept: Accept; signature: Signature } {
  const accept: Accept = {
    v: 1,
    type: "openglass.accept",
    sessionId: opts.offer.sessionId,
    offerHash: hex(sha256(canonicalizeToBytes(opts.offer))),
    counterparty: { agentId: opts.counterparty.agentId, kid: opts.counterparty.kid, publicKey: opts.counterparty.publicKey },
    acceptedAt: new Date(Date.now() + (opts.acceptedAtOffsetMs ?? 0)).toISOString(),
  };
  const signature: Signature = { alg: "Ed25519", kid: opts.counterparty.kid, sig: signPurpose(opts.counterparty.privateKey, "accept", accept) };
  return { accept, signature };
}

/** A well-formed, signed, correctly-chained `MessageEnvelope` (SPEC §7.3), ready to POST
 * to /v1/sessions/{id}/messages. */
export function buildMessage(opts: {
  sessionId: string;
  seq: number;
  prevHash: string;
  sender: TestAgentIdentity;
  mode: "relay" | "notary";
  payload?: unknown;
  sentAtOffsetMs?: number;
}): { envelope: MessageEnvelope; hash: string; signature: Signature; payload?: unknown } {
  const payload = opts.mode === "relay" ? (opts.payload ?? { text: "hello" }) : undefined;
  const payloadHash = hex(sha256(canonicalizeToBytes(payload ?? null)));
  const envelope: MessageEnvelope = {
    v: 1,
    type: "openglass.message",
    sessionId: opts.sessionId,
    seq: opts.seq,
    prevHash: opts.prevHash,
    sender: { agentId: opts.sender.agentId, kid: opts.sender.kid },
    contentType: "application/json",
    payloadHash,
    sentAt: new Date(Date.now() + (opts.sentAtOffsetMs ?? 0)).toISOString(),
  };
  const hashBytes = sha256(Buffer.concat([Buffer.from(opts.prevHash, "hex"), canonicalizeToBytes(envelope)]));
  const hash = hex(hashBytes);
  const signature: Signature = { alg: "Ed25519", kid: opts.sender.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), opts.sender.privateKey)) };
  return { envelope, hash, signature, ...(opts.mode === "relay" ? { payload } : {}) };
}

export async function insertTestOwner(db: Db, email: string): Promise<OwnerDoc> {
  const now = new Date();
  return ownersRepository(db).insert({
    _id: newId("own"),
    email,
    displayName: null,
    settings: { requireInviteApproval: false, emailOnRecord: true },
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });
}
