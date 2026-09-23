import { base64UrlEncode, canonicalizeToBytes, newId, sha256, signEd25519, sigInput } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
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

async function activateSession() {
  const initiator = await registerAndClaim(`ci_${newId("agt").slice(-6)}`);
  const counterparty = await registerAndClaim(`cc_${newId("agt").slice(-6)}`);
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

describe("POST /v1/sessions/{id}/close", () => {
  it("lets a participant close an active session at the current head (headSeq 0)", async () => {
    const { initiator, sessionId } = await activateSession();
    const statement = { v: 1 as const, type: "openglass.close" as const, sessionId, headSeq: 0, headHash: null, closedAt: new Date().toISOString() };
    const signature = {
      alg: "Ed25519" as const,
      kid: initiator.kid,
      sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), initiator.privateKey)),
    };
    const path = `/v1/sessions/${sessionId}/close`;
    const body = { statement, signature };
    const headers = signedRequestHeaders({ method: "POST", path, body, identity: initiator });
    const res = await app().inject({ method: "POST", url: path, headers, payload: body });
    expect(res.statusCode).toBe(202);
    expect(res.json().session.status).toBe("closing");
    expect(res.json().session.closing.reason).toBe("agent_closed");
    expect(res.json().session.closing.requestedBy).toBe(initiator.agentId);
  });

  it("rejects a close statement whose head doesn't match", async () => {
    const { initiator, sessionId } = await activateSession();
    const statement = { v: 1 as const, type: "openglass.close" as const, sessionId, headSeq: 5, headHash: "a".repeat(64), closedAt: new Date().toISOString() };
    const signature = {
      alg: "Ed25519" as const,
      kid: initiator.kid,
      sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), initiator.privateKey)),
    };
    const path = `/v1/sessions/${sessionId}/close`;
    const body = { statement, signature };
    const headers = signedRequestHeaders({ method: "POST", path, body, identity: initiator });
    const res = await app().inject({ method: "POST", url: path, headers, payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("head_mismatch");
  });
});
