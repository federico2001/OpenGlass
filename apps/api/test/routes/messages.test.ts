import { newId } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
  buildMessage,
  buildOffer,
  claimAgentDirectly,
  insertTestOwner,
  signedRequestHeaders,
  testIdentity,
  testServerDeps,
} from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "request_nonces", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAndClaim(name: string) {
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}@example.com`);
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return identity;
}

async function activateSession(mode: "relay" | "notary" = "relay") {
  const initiator = await registerAndClaim(`init_${mode}_${newId("agt").slice(-6)}`);
  const counterparty = await registerAndClaim(`cp_${mode}_${newId("agt").slice(-6)}`);
  const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator, counterpartyAgentId: counterparty.agentId, mode });
  const createBody = { offer, offerSignature };
  const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: initiator });
  const createRes = await app().inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
  const inviteId = createRes.json().invite.id as string;

  const { accept, signature } = buildAccept({ offer, counterparty });
  const acceptPath = `/v1/invites/${inviteId}/accept`;
  const acceptBody = { accept, signature };
  const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: counterparty });
  const acceptRes = await app().inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });

  return { initiator, counterparty, sessionId: offer.sessionId, genesisHash: acceptRes.json().session.genesisHash as string };
}

function sendMessage(sessionId: string, sender: Awaited<ReturnType<typeof registerAndClaim>>, body: Record<string, unknown>) {
  const path = `/v1/sessions/${sessionId}/messages`;
  const headers = signedRequestHeaders({ method: "POST", path, body, identity: sender });
  return app().inject({ method: "POST", url: path, headers, payload: body });
}

describe("POST /v1/sessions/{id}/messages (relay mode)", () => {
  it("appends a chain of messages and advances the head each time", async () => {
    const { initiator, counterparty, sessionId, genesisHash } = await activateSession("relay");

    const m1 = buildMessage({ sessionId, seq: 1, prevHash: genesisHash, sender: initiator, mode: "relay", payload: { text: "hi" } });
    const r1 = await sendMessage(sessionId, initiator, m1);
    expect(r1.statusCode).toBe(201);
    expect(r1.json().head).toEqual({ seq: 1, hash: m1.hash });
    expect(r1.json().message.payload).toEqual({ text: "hi" });

    const m2 = buildMessage({ sessionId, seq: 2, prevHash: m1.hash, sender: counterparty, mode: "relay", payload: { text: "hey back" } });
    const r2 = await sendMessage(sessionId, counterparty, m2);
    expect(r2.statusCode).toBe(201);
    expect(r2.json().head).toEqual({ seq: 2, hash: m2.hash });
  });

  it("rejects a message that doesn't chain off the current head (chain_conflict)", async () => {
    const { initiator, sessionId } = await activateSession("relay");
    const stale = buildMessage({ sessionId, seq: 1, prevHash: "0".repeat(64), sender: initiator, mode: "relay" });
    const res = await sendMessage(sessionId, initiator, stale);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("chain_conflict");
    expect(res.json().error.details.head).toEqual({ seq: 0, hash: null });
  });

  it("rejects a message signed with a key other than the one pinned to this session", async () => {
    const { initiator, sessionId, genesisHash } = await activateSession("relay");
    // Same agentId, but a different (syntactically valid, never-registered) key id — the
    // request itself is authenticated as `initiator` via OG-*, but the envelope claims a
    // sender.kid that isn't the kid pinned to this session at offer time.
    const impostor = testIdentity(initiator.agentId, newId("key"));
    const m = buildMessage({ sessionId, seq: 1, prevHash: genesisHash, sender: impostor, mode: "relay" });
    const res = await sendMessage(sessionId, initiator, m);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("key_not_pinned");
  });

  it("rejects a message whose hash doesn't match prevHash+envelope", async () => {
    const { initiator, sessionId, genesisHash } = await activateSession("relay");
    const m = buildMessage({ sessionId, seq: 1, prevHash: genesisHash, sender: initiator, mode: "relay" });
    m.hash = "1".repeat(64);
    const res = await sendMessage(sessionId, initiator, m);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("hash_mismatch");
  });

  it("rejects sending on a session that isn't active yet", async () => {
    const initiator = await registerAndClaim(`pending_init_${newId("agt").slice(-6)}`);
    const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator });
    const body = { offer, offerSignature };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body, identity: initiator });
    await app().inject({ method: "POST", url: "/v1/sessions", headers, payload: body });

    const m = buildMessage({ sessionId: offer.sessionId, seq: 1, prevHash: "0".repeat(64), sender: initiator, mode: "relay" });
    const res = await sendMessage(offer.sessionId, initiator, m);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("session_not_active");
  });
});

describe("POST /v1/sessions/{id}/messages (notary mode)", () => {
  it("rejects a payload being sent at all", async () => {
    const { initiator, sessionId, genesisHash } = await activateSession("notary");
    const m = buildMessage({ sessionId, seq: 1, prevHash: genesisHash, sender: initiator, mode: "notary" });
    const res = await sendMessage(sessionId, initiator, { ...m, payload: { sneaky: true } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("payload_not_allowed");
  });

  it("accepts a payload-less message carrying only the hash", async () => {
    const { initiator, sessionId, genesisHash } = await activateSession("notary");
    const m = buildMessage({ sessionId, seq: 1, prevHash: genesisHash, sender: initiator, mode: "notary" });
    const res = await sendMessage(sessionId, initiator, m);
    expect(res.statusCode).toBe(201);
    expect(res.json().message.payload).toBeUndefined();
  });
});

describe("GET /v1/sessions/{id}/messages", () => {
  it("lists messages in order and supports afterSeq pagination", async () => {
    const { initiator, counterparty, sessionId, genesisHash } = await activateSession("relay");
    const m1 = buildMessage({ sessionId, seq: 1, prevHash: genesisHash, sender: initiator, mode: "relay" });
    await sendMessage(sessionId, initiator, m1);
    const m2 = buildMessage({ sessionId, seq: 2, prevHash: m1.hash, sender: counterparty, mode: "relay" });
    await sendMessage(sessionId, counterparty, m2);

    const listPath = `/v1/sessions/${sessionId}/messages`;
    const listRes = await app().inject({ method: "GET", url: listPath, headers: signedRequestHeaders({ method: "GET", path: listPath, identity: initiator }) });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);

    const afterPath = `/v1/sessions/${sessionId}/messages?afterSeq=1`;
    const afterRes = await app().inject({ method: "GET", url: afterPath, headers: signedRequestHeaders({ method: "GET", path: afterPath, identity: initiator }) });
    expect(afterRes.json().items.map((m: { seq: number }) => m.seq)).toEqual([2]);
  });
});
