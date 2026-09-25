import { newId } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
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

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "request_nonces", "rate_limits", "web_sessions"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAndClaim(name: string): Promise<TestAgentIdentity & { ownerId: string }> {
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}@example.com`);
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return Object.assign(identity, { ownerId: owner._id });
}

async function activateSession() {
  const initiator = await registerAndClaim(`pi_${newId("agt").slice(-6)}`);
  const counterparty = await registerAndClaim(`pc_${newId("agt").slice(-6)}`);
  const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator, counterpartyAgentId: counterparty.agentId });
  const createBody = { offer, offerSignature };
  const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: initiator });
  const createRes = await app().inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
  const inviteId = createRes.json().invite.id as string;

  const { accept, signature } = buildAccept({ offer, counterparty });
  const acceptPath = `/v1/invites/${inviteId}/accept`;
  const acceptBody = { accept, signature };
  const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: counterparty });
  await app().inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });

  return { initiator, counterparty, sessionId: offer.sessionId };
}

describe("POST /v1/sessions/{id}/pause", () => {
  it("pauses an active session and blocks message sending until resumed", async () => {
    const { initiator, counterparty, sessionId } = await activateSession();

    const pausePath = `/v1/sessions/${sessionId}/pause`;
    const pauseBody = { reason: "Checking with my owner before agreeing to this price" };
    const pauseHeaders = signedRequestHeaders({ method: "POST", path: pausePath, body: pauseBody, identity: initiator });
    const pauseRes = await app().inject({ method: "POST", url: pausePath, headers: pauseHeaders, payload: pauseBody });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().session.status).toBe("paused");
    expect(pauseRes.json().session.pause.requestedBy).toBe(initiator.agentId);
    expect(pauseRes.json().session.pause.reason).toBe(pauseBody.reason);

    // Neither side can append messages while paused.
    const msgPath = `/v1/sessions/${sessionId}/messages`;
    const envelope = {
      v: 1 as const,
      type: "openglass.message" as const,
      sessionId,
      seq: 1,
      prevHash: "0".repeat(64),
      sender: { agentId: counterparty.agentId, kid: counterparty.kid },
      contentType: "application/json",
      payloadHash: "0".repeat(64),
      sentAt: new Date().toISOString(),
    };
    const msgBody = { envelope, hash: "0".repeat(64), signature: { alg: "Ed25519" as const, kid: counterparty.kid, sig: "c2ln" }, payload: { text: "hi" } };
    const msgHeaders = signedRequestHeaders({ method: "POST", path: msgPath, body: msgBody, identity: counterparty });
    const msgRes = await app().inject({ method: "POST", url: msgPath, headers: msgHeaders, payload: msgBody });
    expect(msgRes.statusCode).toBe(409);
    expect(msgRes.json().error.code).toBe("session_not_active");
  });

  it("rejects pausing a session the caller isn't a participant in", async () => {
    const { sessionId } = await activateSession();
    const stranger = await registerAndClaim(`ps_${newId("agt").slice(-6)}`);
    const path = `/v1/sessions/${sessionId}/pause`;
    const body = { reason: "not mine to pause" };
    const headers = signedRequestHeaders({ method: "POST", path, body, identity: stranger });
    const res = await app().inject({ method: "POST", url: path, headers, payload: body });
    expect(res.statusCode).toBe(404);
  });

  it("rejects pausing a session that isn't active", async () => {
    const { initiator, sessionId } = await activateSession();
    const path = `/v1/sessions/${sessionId}/pause`;
    const body = { reason: "first pause" };
    const headers = signedRequestHeaders({ method: "POST", path, body, identity: initiator });
    await app().inject({ method: "POST", url: path, headers, payload: body });

    const secondHeaders = signedRequestHeaders({ method: "POST", path, body, identity: initiator });
    const res = await app().inject({ method: "POST", url: path, headers: secondHeaders, payload: body });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("session_not_active");
  });
});

describe("POST /v1/owner/sessions/{id}/resume and /decline-resume", () => {
  async function pausedSession() {
    const { initiator, counterparty, sessionId } = await activateSession();
    const path = `/v1/sessions/${sessionId}/pause`;
    const body = { reason: "Need a human to look at this" };
    const headers = signedRequestHeaders({ method: "POST", path, body, identity: initiator });
    await app().inject({ method: "POST", url: path, headers, payload: body });
    return { initiator, counterparty, sessionId };
  }

  it("lets either participant's owner resume a paused session", async () => {
    const { counterparty, sessionId } = await pausedSession();
    const cookie = await createOwnerSessionCookie(t.db, counterparty.ownerId);
    const res = await app().inject({
      method: "POST",
      url: `/v1/owner/sessions/${sessionId}/resume`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe("active");
    expect(res.json().session.pause).toBeNull();
  });

  it("lets either participant's owner decline, moving the session to closing", async () => {
    const { initiator, sessionId } = await pausedSession();
    const cookie = await createOwnerSessionCookie(t.db, initiator.ownerId);
    const res = await app().inject({
      method: "POST",
      url: `/v1/owner/sessions/${sessionId}/decline-resume`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe("closing");
    expect(res.json().session.closing.reason).toBe("owner_declined_pause");
    expect(res.json().session.pause).toBeNull();
  });

  it("rejects resume from an owner with no stake in the session", async () => {
    const { sessionId } = await pausedSession();
    const stranger = await insertTestOwner(t.db, `stranger_${newId("own").slice(-6)}@example.com`.toLowerCase());
    const cookie = await createOwnerSessionCookie(t.db, stranger._id);
    const res = await app().inject({
      method: "POST",
      url: `/v1/owner/sessions/${sessionId}/resume`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects resuming a session that isn't paused", async () => {
    const { initiator, sessionId } = await activateSession();
    const cookie = await createOwnerSessionCookie(t.db, initiator.ownerId);
    const res = await app().inject({
      method: "POST",
      url: `/v1/owner/sessions/${sessionId}/resume`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("session_not_paused");
  });
});
