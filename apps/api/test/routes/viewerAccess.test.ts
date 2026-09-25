import {
  base64UrlEncode,
  canonicalizeToBytes,
  newId,
  sha256,
  signEd25519,
  sigInput,
} from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { openTestS3 } from "../../../../packages/db/test/testS3.js";
import { issueRecords } from "../../../worker/src/jobs/issueRecords.js";
import { createCapturingMailer as createWorkerMailer } from "../../../worker/src/mailer.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
  buildMessage,
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
 * Viewer access (Prompt 6, CLAUDE.md feedback item 1): an owner grants a human — legal, a
 * manager, an auditor — read-only access to one of their agents. This exercises both
 * halves through the real HTTP API: the granting side (invite/list/revoke on
 * /v1/owner/agents/{id}/viewers) and the receiving side (the invited email, once signed
 * in like any owner, reading exactly the sessions/messages/records its grant covers —
 * nothing more — via the extended access rule in domain/access.ts).
 *
 * One shared `app`/`signer` for the whole file, same reasoning as
 * integration/sessionLifecycle.test.ts: the worker's `issueRecords` re-verifies the chain
 * with the same signer that countersigned it, so every request in the record-issuance
 * test must go through one Fastify instance built from one signer.
 */

let t: Awaited<ReturnType<typeof openTestDb>>;
let s3: Awaited<ReturnType<typeof openTestS3>>;
let app: ReturnType<typeof buildServer>;
let signer: ReturnType<typeof testServerDeps>["signer"];
let mailer: ReturnType<typeof testServerDeps>["mailer"];

beforeAll(async () => {
  t = await openTestDb();
  s3 = await openTestS3();
  const deps = testServerDeps(t, { client: s3.client, bucket: s3.bucket });
  signer = deps.signer;
  mailer = deps.mailer;
  app = buildServer({ ...deps, healthChecks: {} });
});
afterAll(async () => {
  await t.cleanup();
  await s3.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "records", "viewer_grants", "web_sessions", "request_nonces", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
  mailer.sent.length = 0;
});

async function registerAndClaimFor(name: string, ownerId: string): Promise<TestAgentIdentity> {
  const identity = testIdentity(`va_${name}`, `va_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  await claimAgentDirectly(t.db, identity.agentId, ownerId);
  return identity;
}

async function activateSession(initiator: TestAgentIdentity, counterparty: TestAgentIdentity) {
  const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator, counterpartyAgentId: counterparty.agentId });
  const createBody = { offer, offerSignature };
  const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: initiator });
  const createRes = await app.inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
  const inviteId = createRes.json().invite.id as string;
  const { accept, signature } = buildAccept({ offer, counterparty });
  const acceptPath = `/v1/invites/${inviteId}/accept`;
  const acceptBody = { accept, signature };
  const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: counterparty });
  const acceptRes = await app.inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });
  return { sessionId: offer.sessionId, genesisHash: acceptRes.json().session.genesisHash as string };
}

function signClose(sessionId: string, headSeq: number, headHash: string | null, identity: TestAgentIdentity) {
  const statement = { v: 1 as const, type: "openglass.close" as const, sessionId, headSeq, headHash, closedAt: new Date().toISOString() };
  const signature = {
    alg: "Ed25519" as const,
    kid: identity.kid,
    sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), identity.privateKey)),
  };
  return { statement, signature };
}

function inviteViewer(agentId: string, ownerCookie: string, email: string, label?: string) {
  return app.inject({
    method: "POST",
    url: `/v1/owner/agents/${agentId}/viewers`,
    headers: { cookie: ownerCookie, origin: "https://localhost", "content-type": "application/json" },
    payload: { email, ...(label ? { label } : {}) },
  });
}

describe("granting viewer access", () => {
  it("invites, lists, and revokes a viewer on an owned agent; re-inviting after revoke reactivates the grant", async () => {
    const owner = await insertTestOwner(t.db, `owner_${newId("own").slice(-6)}@example.com`);
    const agent = await registerAndClaimFor(`agent_${newId("agt").slice(-6)}`, owner._id);
    const cookie = await createOwnerSessionCookie(t.db, owner._id);

    const inviteRes = await inviteViewer(agent.agentId, cookie, "legal@example.com", "Legal counsel");
    expect(inviteRes.statusCode).toBe(201);
    expect(inviteRes.json().grant.viewerEmail).toBe("legal@example.com");
    expect(inviteRes.json().grant.label).toBe("Legal counsel");
    expect(inviteRes.json().grant.status).toBe("active");
    const sent = mailer.sent as { kind: string; to: string }[];
    expect(sent.some((m) => m.kind === "viewer_invite" && m.to === "legal@example.com")).toBe(true);

    // duplicate (case-insensitive) invite is a conflict, not a second grant
    const dupRes = await inviteViewer(agent.agentId, cookie, "Legal@Example.com");
    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().error.code).toBe("viewer_exists");

    const listRes = await app.inject({ method: "GET", url: `/v1/owner/agents/${agent.agentId}/viewers`, headers: { cookie } });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items).toHaveLength(1);
    const grantId = listRes.json().items[0].id as string;

    const revokeRes = await app.inject({
      method: "POST",
      url: `/v1/owner/agents/${agent.agentId}/viewers/${grantId}/revoke`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().grant.status).toBe("revoked");

    // revoking an already-revoked grant is idempotent, not an error
    const revokeAgainRes = await app.inject({
      method: "POST",
      url: `/v1/owner/agents/${agent.agentId}/viewers/${grantId}/revoke`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(revokeAgainRes.statusCode).toBe(200);
    expect(revokeAgainRes.json().grant.status).toBe("revoked");

    const reinviteRes = await inviteViewer(agent.agentId, cookie, "legal@example.com");
    expect(reinviteRes.statusCode).toBe(201);
    expect(reinviteRes.json().grant.id).toBe(grantId); // same grant, not a duplicate row
    expect(reinviteRes.json().grant.status).toBe("active");
  });

  it("404s inviting, listing, or revoking on an agent the caller doesn't own", async () => {
    const owner = await insertTestOwner(t.db, `owner_${newId("own").slice(-6)}@example.com`);
    const stranger = await insertTestOwner(t.db, `stranger_${newId("own").slice(-6)}@example.com`);
    const agent = await registerAndClaimFor(`agent_${newId("agt").slice(-6)}`, owner._id);
    const strangerCookie = await createOwnerSessionCookie(t.db, stranger._id);

    expect((await inviteViewer(agent.agentId, strangerCookie, "legal@example.com")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/owner/agents/${agent.agentId}/viewers`, headers: { cookie: strangerCookie } })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/owner/agents/${agent.agentId}/viewers/${newId("vwg")}/revoke`,
          headers: { cookie: strangerCookie, origin: "https://localhost", "content-type": "application/json" },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("viewer read access", () => {
  it("gives a granted human read access to exactly the session, messages, and record their grant covers, and nothing else — until revoked", async () => {
    const ownerA = await insertTestOwner(t.db, `ownerA_${newId("own").slice(-6)}@example.com`);
    const ownerB = await insertTestOwner(t.db, `ownerB_${newId("own").slice(-6)}@example.com`);
    const agentA = await registerAndClaimFor(`agentA_${newId("agt").slice(-6)}`, ownerA._id);
    const agentB = await registerAndClaimFor(`agentB_${newId("agt").slice(-6)}`, ownerB._id);
    const agentC = await registerAndClaimFor(`agentC_${newId("agt").slice(-6)}`, ownerB._id);

    const { sessionId, genesisHash } = await activateSession(agentA, agentB);
    const { sessionId: otherSessionId } = await activateSession(agentB, agentC); // agentA has no part in this one

    const viewerEmail = `viewer_${newId("own").slice(-6)}@example.com`;
    const ownerACookie = await createOwnerSessionCookie(t.db, ownerA._id);
    expect((await inviteViewer(agentA.agentId, ownerACookie, viewerEmail, "Auditor")).statusCode).toBe(201);

    const msg = buildMessage({ sessionId, seq: 1, prevHash: genesisHash, sender: agentA, mode: "relay", payload: { text: "hi" } });
    const msgPath = `/v1/sessions/${sessionId}/messages`;
    const msgHeaders = signedRequestHeaders({ method: "POST", path: msgPath, body: msg, identity: agentA });
    expect((await app.inject({ method: "POST", url: msgPath, headers: msgHeaders, payload: msg })).statusCode).toBe(201);

    const { statement, signature } = signClose(sessionId, 1, msg.hash, agentA);
    const closePath = `/v1/sessions/${sessionId}/close`;
    const closeBody = { statement, signature };
    const closeHeaders = signedRequestHeaders({ method: "POST", path: closePath, body: closeBody, identity: agentA });
    expect((await app.inject({ method: "POST", url: closePath, headers: closeHeaders, payload: closeBody })).statusCode).toBe(202);

    const issueResult = await issueRecords({
      db: t.db,
      s3: s3.client,
      s3Bucket: s3.bucket,
      signer,
      mailer: createWorkerMailer(),
      publicUrl: "https://localhost",
    });
    expect(issueResult.issued).toBe(1);

    const sessionAfterClose = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}`, headers: { cookie: ownerACookie } });
    const recordId = sessionAfterClose.json().session.recordId as string;
    expect(recordId).toBeTruthy();

    // the viewer signs in the same passwordless way an owner does (magic-link round trip
    // bypassed here, same as createOwnerSessionCookie does for every other test)
    const viewerOwnerDoc = await insertTestOwner(t.db, viewerEmail);
    const viewerCookie = await createOwnerSessionCookie(t.db, viewerOwnerDoc._id);

    const accessRes = await app.inject({ method: "GET", url: "/v1/owner/viewer-access", headers: { cookie: viewerCookie } });
    expect(accessRes.statusCode).toBe(200);
    expect(accessRes.json().items).toHaveLength(1);
    expect(accessRes.json().items[0].agent.id).toBe(agentA.agentId);

    const sessionsListRes = await app.inject({ method: "GET", url: "/v1/owner/viewer-access/sessions", headers: { cookie: viewerCookie } });
    const listedIds = (sessionsListRes.json().items as { id: string }[]).map((s) => s.id);
    expect(listedIds).toContain(sessionId);
    expect(listedIds).not.toContain(otherSessionId);

    expect((await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}`, headers: { cookie: viewerCookie } })).statusCode).toBe(200);

    const messagesRes = await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}/messages`, headers: { cookie: viewerCookie } });
    expect(messagesRes.statusCode).toBe(200);
    expect(messagesRes.json().items).toHaveLength(1);

    expect((await app.inject({ method: "GET", url: `/v1/records/${recordId}`, headers: { cookie: viewerCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/records/${recordId}/bundle`, headers: { cookie: viewerCookie } })).statusCode).toBe(200);

    const recordsListRes = await app.inject({ method: "GET", url: "/v1/owner/viewer-access/records", headers: { cookie: viewerCookie } });
    expect((recordsListRes.json().items as { id: string }[]).map((r) => r.id)).toContain(recordId);

    // no access at all to the session agentA wasn't part of
    expect((await app.inject({ method: "GET", url: `/v1/sessions/${otherSessionId}`, headers: { cookie: viewerCookie } })).statusCode).toBe(404);

    // owner A revokes; every bit of that access disappears
    const grantsListRes = await app.inject({ method: "GET", url: `/v1/owner/agents/${agentA.agentId}/viewers`, headers: { cookie: ownerACookie } });
    const grantId = grantsListRes.json().items[0].id as string;
    const revokeRes = await app.inject({
      method: "POST",
      url: `/v1/owner/agents/${agentA.agentId}/viewers/${grantId}/revoke`,
      headers: { cookie: ownerACookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(revokeRes.statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: `/v1/sessions/${sessionId}`, headers: { cookie: viewerCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/records/${recordId}`, headers: { cookie: viewerCookie } })).statusCode).toBe(404);
    const afterRevokeAccessRes = await app.inject({ method: "GET", url: "/v1/owner/viewer-access", headers: { cookie: viewerCookie } });
    expect(afterRevokeAccessRes.json().items).toHaveLength(0);
  });
});
