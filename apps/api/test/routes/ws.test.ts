import { base64UrlEncode, canonicalizeToBytes, hex, newId, sha256, sigInput, signEd25519 } from "@openglass/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { openTestS3 } from "../../../../packages/db/test/testS3.js";
import { issueRecords } from "../../../worker/src/jobs/issueRecords.js";
import { createCapturingMailer as createWorkerMailer } from "../../../worker/src/mailer.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
  buildOffer,
  claimAgentDirectly,
  createOwnerSessionCookie,
  insertTestOwner,
  signedRequestHeaders,
  testIdentity,
  testServerDeps,
  type TestAgentIdentity,
} from "../helpers.js";

/**
 * Real end-to-end tests of the WS live relay (SPEC §9): a genuine `ws` client, over
 * @fastify/websocket's injectWS (the real upgrade path, dispatched through Fastify's full
 * request lifecycle — not a shortcut), against a real running server backed by real
 * (testcontainers) Mongo, with fan-out driven by real MongoDB change streams. Nothing here
 * is mocked.
 *
 * One shared `app`/`signer` for the whole file (same reasoning as viewerAccess.test.ts):
 * the "automatic session and record events" test's `issueRecords` call re-verifies the
 * chain with the same signer that countersigned it, so every request must go through the
 * one Fastify instance built from that one signer.
 */

let t: Awaited<ReturnType<typeof openTestDb>>;
let s3: Awaited<ReturnType<typeof openTestS3>>;
let app: ReturnType<typeof buildServer>;
let signer: ReturnType<typeof testServerDeps>["signer"];
const openSockets: { close: () => void }[] = [];

beforeAll(async () => {
  t = await openTestDb();
  s3 = await openTestS3();
  const deps = testServerDeps(t, s3);
  signer = deps.signer;
  app = buildServer({ ...deps, healthChecks: {} });
  // Unlike .inject(), injectWS() (from @fastify/websocket) doesn't wait for the instance
  // to finish loading plugins/routes first — without this, the first call in the file
  // hits "app.injectWS is not a function" (plugin not decorated yet).
  await app.ready();
});
afterAll(async () => {
  await t.cleanup();
  await s3.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "records", "web_sessions", "request_nonces", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
});
afterEach(async () => {
  for (const s of openSockets.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 50)); // let server-side close handlers run (hub cleanup)
});

async function registerAndClaim(name: string): Promise<TestAgentIdentity & { ownerId: string }> {
  const identity = testIdentity(`ws_${name}`, `ws_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}_${newId("own").slice(-6)}@example.com`.toLowerCase());
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return Object.assign(identity, { ownerId: owner._id });
}

async function activateSession(initiator: TestAgentIdentity, counterparty: TestAgentIdentity): Promise<string> {
  const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator, counterpartyAgentId: counterparty.agentId });
  const createBody = { offer, offerSignature };
  const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: initiator });
  const createRes = await app.inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
  const inviteId = createRes.json().invite.id as string;

  const { accept, signature } = buildAccept({ offer, counterparty });
  const acceptPath = `/v1/invites/${inviteId}/accept`;
  const acceptBody = { accept, signature };
  const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: counterparty });
  await app.inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });
  return offer.sessionId;
}

function signRequestFrame(identity: TestAgentIdentity) {
  const h = signedRequestHeaders({ method: "GET", path: "/v1/ws", identity });
  return { "og-agent": h["og-agent"]!, "og-key": h["og-key"]!, "og-timestamp": h["og-timestamp"]!, "og-nonce": h["og-nonce"]!, "og-signature": h["og-signature"]! };
}

interface WsLike {
  send: (data: string) => void;
  close: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

async function connectAsAgent(identity: TestAgentIdentity): Promise<WsLike> {
  const ws = (await app.injectWS("/v1/ws", { headers: signRequestFrame(identity) })) as unknown as WsLike;
  openSockets.push(ws);
  return ws;
}

async function connectAsOwner(ownerId: string): Promise<WsLike> {
  const cookie = await createOwnerSessionCookie(t.db, ownerId);
  const ws = (await app.injectWS("/v1/ws", { headers: { cookie, origin: "https://localhost" } })) as unknown as WsLike;
  openSockets.push(ws);
  return ws;
}

function nextFrames(ws: WsLike): {
  collected: Record<string, unknown>[];
  wait: (predicate: (f: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
} {
  const collected: Record<string, unknown>[] = [];
  const waiters: { predicate: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }[] = [];
  ws.on("message", (raw: unknown) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    collected.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.predicate(frame)) {
        waiters[i]!.resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    collected,
    wait: (predicate, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const already = collected.find(predicate);
        if (already) return resolve(already);
        const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for a matching frame`)), timeoutMs);
        waiters.push({
          predicate,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      }),
  };
}

describe("GET /v1/ws auth", () => {
  it("rejects a connection with no credentials", async () => {
    await expect(app.injectWS("/v1/ws")).rejects.toThrow(/401/);
  });

  it("rejects an owner connection with the wrong Origin", async () => {
    const owner = await insertTestOwner(t.db, `origin_${newId("own").slice(-6)}@example.com`.toLowerCase());
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    await expect(app.injectWS("/v1/ws", { headers: { cookie, origin: "https://evil.example" } })).rejects.toThrow(/403/);
  });

  it("accepts a signed agent connection and sends ready", async () => {
    const identity = await registerAndClaim(`agentok_${newId("agt").slice(-6)}`);
    const ws = await connectAsAgent(identity);
    const frames = nextFrames(ws);
    const ready = await frames.wait((f) => f.type === "ready");
    expect((ready.principal as { kind: string; id: string }).kind).toBe("agent");
    expect((ready.principal as { kind: string; id: string }).id).toBe(identity.agentId);
  });

  it("accepts an owner cookie connection with the right Origin and sends ready", async () => {
    const owner = await insertTestOwner(t.db, `originok_${newId("own").slice(-6)}@example.com`.toLowerCase());
    const ws = await connectAsOwner(owner._id);
    const frames = nextFrames(ws);
    const ready = await frames.wait((f) => f.type === "ready");
    expect((ready.principal as { kind: string; id: string }).kind).toBe("owner");
    expect((ready.principal as { kind: string; id: string }).id).toBe(owner._id);
  });
});

describe("subscribe / message.send", () => {
  it("subscribes, replays backlog after afterSeq, and fans out a new message to another subscriber in real time", async () => {
    const alice = await registerAndClaim(`alice_${newId("agt").slice(-6)}`);
    const bob = await registerAndClaim(`bob_${newId("agt").slice(-6)}`);
    const sessionId = await activateSession(alice, bob);

    // one message already sent via REST, before either side connects over WS
    const genesisRes = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: signedRequestHeaders({ method: "GET", path: `/v1/sessions/${sessionId}`, identity: alice }),
    });
    const genesisHash = genesisRes.json().session.genesisHash as string;
    const payload1 = { text: "first" };
    const payloadHash1 = hex(sha256(canonicalizeToBytes(payload1)));
    const envelope1 = {
      v: 1 as const,
      type: "openglass.message" as const,
      sessionId,
      seq: 1,
      prevHash: genesisHash,
      sender: { agentId: alice.agentId, kid: alice.kid },
      contentType: "application/json",
      payloadHash: payloadHash1,
      sentAt: new Date().toISOString(),
    };
    const hashBytes1 = sha256(Buffer.concat([Buffer.from(genesisHash, "hex"), canonicalizeToBytes(envelope1)]));
    const hash1 = hex(hashBytes1);
    const sig1 = { alg: "Ed25519" as const, kid: alice.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes1), alice.privateKey)) };
    const msgBody1 = { envelope: envelope1, hash: hash1, signature: sig1, payload: payload1 };
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: signedRequestHeaders({ method: "POST", path: `/v1/sessions/${sessionId}/messages`, body: msgBody1, identity: alice }),
      payload: msgBody1,
    });

    // bob subscribes over WS — should get the backlog replay of message #1
    const bobWs = await connectAsAgent(bob);
    const bobFrames = nextFrames(bobWs);
    await bobFrames.wait((f) => f.type === "ready");
    bobWs.send(JSON.stringify({ type: "subscribe", id: "sub1", sessionId, afterSeq: 0 }));
    const backlogMsg = await bobFrames.wait((f) => f.type === "message" && (f.message as { seq: number }).seq === 1);
    expect((backlogMsg.message as { payload: { text: string } }).payload.text).toBe("first");
    await bobFrames.wait((f) => f.type === "ack" && f.id === "sub1");

    // alice sends message #2 live, over WS — bob (subscribed) should receive it via change-stream fan-out
    const aliceWs = await connectAsAgent(alice);
    const aliceFrames = nextFrames(aliceWs);
    await aliceFrames.wait((f) => f.type === "ready");
    const payload2 = { text: "second" };
    const payloadHash2 = hex(sha256(canonicalizeToBytes(payload2)));
    const envelope2 = {
      v: 1 as const,
      type: "openglass.message" as const,
      sessionId,
      seq: 2,
      prevHash: hash1,
      sender: { agentId: alice.agentId, kid: alice.kid },
      contentType: "application/json",
      payloadHash: payloadHash2,
      sentAt: new Date().toISOString(),
    };
    const hashBytes2 = sha256(Buffer.concat([Buffer.from(hash1, "hex"), canonicalizeToBytes(envelope2)]));
    const hash2 = hex(hashBytes2);
    const sig2 = { alg: "Ed25519" as const, kid: alice.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes2), alice.privateKey)) };
    aliceWs.send(JSON.stringify({ type: "message.send", id: "send1", sessionId, envelope: envelope2, hash: hash2, signature: sig2, payload: payload2 }));

    const ack = await aliceFrames.wait((f) => f.type === "ack" && f.id === "send1");
    expect((ack.result as { head: { seq: number } }).head.seq).toBe(2);

    const live = await bobFrames.wait((f) => f.type === "message" && (f.message as { seq: number }).seq === 2, 8000);
    expect((live.message as { payload: { text: string } }).payload.text).toBe("second");
  });

  it("rejects subscribing to a session the caller isn't a participant in or owner of", async () => {
    const alice = await registerAndClaim(`alice2_${newId("agt").slice(-6)}`);
    const bob = await registerAndClaim(`bob2_${newId("agt").slice(-6)}`);
    const stranger = await registerAndClaim(`stranger_${newId("agt").slice(-6)}`);
    const sessionId = await activateSession(alice, bob);

    const ws = await connectAsAgent(stranger);
    const frames = nextFrames(ws);
    await frames.wait((f) => f.type === "ready");
    ws.send(JSON.stringify({ type: "subscribe", id: "s1", sessionId }));
    const err = await frames.wait((f) => f.type === "error" && f.id === "s1");
    expect((err.error as { code: string }).code).toBe("not_found");
  });

  it("rejects message.send from an owner connection", async () => {
    const alice = await registerAndClaim(`alice3_${newId("agt").slice(-6)}`);
    const bob = await registerAndClaim(`bob3_${newId("agt").slice(-6)}`);
    const sessionId = await activateSession(alice, bob);

    const ws = await connectAsOwner(alice.ownerId);
    const frames = nextFrames(ws);
    await frames.wait((f) => f.type === "ready");
    ws.send(
      JSON.stringify({
        type: "message.send",
        id: "m1",
        sessionId,
        envelope: {},
        hash: "a".repeat(64),
        signature: { alg: "Ed25519", kid: "x", sig: "y" },
      }),
    );
    const err = await frames.wait((f) => f.type === "error" && f.id === "m1");
    expect((err.error as { code: string }).code).toBe("unauthenticated");
  });
});

describe("automatic session and record events", () => {
  it("delivers session.closing and record.issued to a participant agent that never subscribed", async () => {
    const alice = await registerAndClaim(`alice4_${newId("agt").slice(-6)}`);
    const bob = await registerAndClaim(`bob4_${newId("agt").slice(-6)}`);
    const sessionId = await activateSession(alice, bob);

    const bobWs = await connectAsAgent(bob);
    const bobFrames = nextFrames(bobWs);
    await bobFrames.wait((f) => f.type === "ready");

    const closePath = `/v1/sessions/${sessionId}/close`;
    const statement = { v: 1 as const, type: "openglass.close" as const, sessionId, headSeq: 0, headHash: null, closedAt: new Date().toISOString() };
    const closeSig = {
      alg: "Ed25519" as const,
      kid: alice.kid,
      sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), alice.privateKey)),
    };
    const closeBody = { statement, signature: closeSig };
    await app.inject({
      method: "POST",
      url: closePath,
      headers: signedRequestHeaders({ method: "POST", path: closePath, body: closeBody, identity: alice }),
      payload: closeBody,
    });

    // bob never subscribed to this session, but gets session.closing automatically as a participant
    const closing = await bobFrames.wait((f) => f.type === "session.closing", 8000);
    expect((closing.session as { id: string }).id).toBe(sessionId);

    // finish the job the worker would normally do, with the same signer the session was
    // countersigned with, so issueRecords' own re-verification (SPEC §7.6) passes
    const mailer = createWorkerMailer();
    const result = await issueRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer, mailer, publicUrl: "https://localhost" });
    expect(result.issued).toBe(1);

    const issued = await bobFrames.wait((f) => f.type === "record.issued" && f.sessionId === sessionId, 8000);
    expect(issued.recordId).toBeTruthy();
  });
});

describe("ping", () => {
  it("replies pong to an application-level ping frame", async () => {
    const identity = await registerAndClaim(`pinger_${newId("agt").slice(-6)}`);
    const ws = await connectAsAgent(identity);
    const frames = nextFrames(ws);
    await frames.wait((f) => f.type === "ready");
    ws.send(JSON.stringify({ type: "ping", id: "p1" }));
    const pong = await frames.wait((f) => f.type === "pong" && f.id === "p1");
    expect(pong.type).toBe("pong");
  });
});
