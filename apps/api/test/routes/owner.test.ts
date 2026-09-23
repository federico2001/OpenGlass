import { newId, ownersRepository, type SessionDoc } from "@openglass/db";
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
} from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "web_sessions", "request_nonces", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAndClaimFor(name: string, ownerId: string) {
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  await claimAgentDirectly(t.db, identity.agentId, ownerId);
  return identity;
}

describe("GET/PATCH /v1/owner/me", () => {
  it("reads and updates the owner's own profile", async () => {
    const owner = await insertTestOwner(t.db, "profile@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);

    const getRes = await app().inject({ method: "GET", url: "/v1/owner/me", headers: { cookie } });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().owner.email).toBe("profile@example.com");

    const patchRes = await app().inject({
      method: "PATCH",
      url: "/v1/owner/me",
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { displayName: "Alice", settings: { requireInviteApproval: true } },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().owner.displayName).toBe("Alice");
    expect(patchRes.json().owner.settings).toEqual({ requireInviteApproval: true, emailOnRecord: true });
  });
});

describe("agent suspend/unsuspend", () => {
  it("suspending closes active sessions and cancels pending ones, owned by that owner only", async () => {
    const owner = await insertTestOwner(t.db, "suspender@example.com");
    const otherOwner = await insertTestOwner(t.db, "other@example.com");
    const agentA = await registerAndClaimFor(`susp_a_${newId("agt").slice(-6)}`, owner._id);
    const agentB = await registerAndClaimFor(`susp_b_${newId("agt").slice(-6)}`, otherOwner._id);
    const agentC = await registerAndClaimFor(`susp_c_${newId("agt").slice(-6)}`, otherOwner._id);

    // an ACTIVE session between A and B
    const { offer: offerActive, offerSignature: sigActive } = buildOffer({ sessionId: newId("ses"), initiator: agentA, counterpartyAgentId: agentB.agentId });
    const createActiveBody = { offer: offerActive, offerSignature: sigActive };
    const createActiveHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createActiveBody, identity: agentA });
    const createActiveRes = await app().inject({ method: "POST", url: "/v1/sessions", headers: createActiveHeaders, payload: createActiveBody });
    const { accept, signature } = buildAccept({ offer: offerActive, counterparty: agentB });
    const acceptPath = `/v1/invites/${createActiveRes.json().invite.id}/accept`;
    const acceptBody = { accept, signature };
    const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: agentB });
    await app().inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });

    // a PENDING session offered by A to C
    const { offer: offerPending, offerSignature: sigPending } = buildOffer({ sessionId: newId("ses"), initiator: agentA, counterpartyAgentId: agentC.agentId });
    const createPendingBody = { offer: offerPending, offerSignature: sigPending };
    const createPendingHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createPendingBody, identity: agentA });
    await app().inject({ method: "POST", url: "/v1/sessions", headers: createPendingHeaders, payload: createPendingBody });

    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const suspendPath = `/v1/owner/agents/${agentA.agentId}/suspend`;
    const res = await app().inject({
      method: "POST",
      url: suspendPath,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.status).toBe("suspended");

    const activeSession = await t.db.collection<SessionDoc>("sessions").findOne({ _id: offerActive.sessionId });
    expect(activeSession!.status).toBe("closing");
    expect(activeSession!.closing!.reason).toBe("agent_suspended");

    const pendingSession = await t.db.collection<SessionDoc>("sessions").findOne({ _id: offerPending.sessionId });
    expect(pendingSession!.status).toBe("cancelled");
  });

  it("rejects suspending an agent that belongs to a different owner", async () => {
    const owner = await insertTestOwner(t.db, "notmine@example.com");
    const actualOwner = await insertTestOwner(t.db, "actual@example.com");
    const agent = await registerAndClaimFor(`unauth_${newId("agt").slice(-6)}`, actualOwner._id);
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const res = await app().inject({
      method: "POST",
      url: `/v1/owner/agents/${agent.agentId}/suspend`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("owner invite approval (D5)", () => {
  it("approving an awaiting invite activates the session", async () => {
    const initOwner = await insertTestOwner(t.db, "appr_init_owner@example.com");
    const cpOwner = await insertTestOwner(t.db, "appr_cp_owner@example.com");
    await ownersRepository(t.db).update(cpOwner._id, { settings: { requireInviteApproval: true, emailOnRecord: true } });
    const initiator = await registerAndClaimFor(`appr_init_${newId("agt").slice(-6)}`, initOwner._id);
    const counterparty = await registerAndClaimFor(`appr_cp_${newId("agt").slice(-6)}`, cpOwner._id);

    const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator, counterpartyAgentId: counterparty.agentId });
    const createBody = { offer, offerSignature };
    const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: initiator });
    const createRes = await app().inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
    const inviteId = createRes.json().invite.id as string;

    const { accept, signature } = buildAccept({ offer, counterparty });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const acceptBody = { accept, signature };
    const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: counterparty });
    const acceptRes = await app().inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });
    expect(acceptRes.statusCode).toBe(202);

    const cookie = await createOwnerSessionCookie(t.db, cpOwner._id);
    const listRes = await app().inject({ method: "GET", url: "/v1/owner/invites", headers: { cookie } });
    expect(listRes.json().items.map((i: { id: string }) => i.id)).toContain(inviteId);

    const approveRes = await app().inject({
      method: "POST",
      url: `/v1/owner/invites/${inviteId}/approve`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().session.status).toBe("active");
    expect(approveRes.json().session.genesisHash).toBeTruthy();
    expect(approveRes.json().invite.status).toBe("accepted");
  });
});
