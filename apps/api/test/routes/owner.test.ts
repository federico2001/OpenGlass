import { newId, ownersRepository, type SessionDoc } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
  buildAttestationOpen,
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
  for (const c of ["agents", "owners", "sessions", "invites", "attestations", "web_sessions", "request_nonces", "rate_limits"]) {
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
    expect(getRes.json().isAdmin).toBe(false);

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

  it("reports isAdmin for an owner listed in ADMIN_EMAILS", async () => {
    const owner = await insertTestOwner(t.db, "admin@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const res = await app().inject({ method: "GET", url: "/v1/owner/me", headers: { cookie } });
    expect(res.json().isAdmin).toBe(true);
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

describe("PATCH /v1/owner/agents/{id}/retention (realignment R1, docs/SPEC.md §13)", () => {
  it("sets and clears the owner's private-retention override", async () => {
    const owner = await insertTestOwner(t.db, "retention@example.com");
    const agent = await registerAndClaimFor(`retention_${newId("agt").slice(-6)}`, owner._id);
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const path = `/v1/owner/agents/${agent.agentId}/retention`;

    const setRes = await app().inject({
      method: "PATCH",
      url: path,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { privateRetentionDays: 30 },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().agent.privateRetentionDays).toBe(30);

    const clearRes = await app().inject({
      method: "PATCH",
      url: path,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { privateRetentionDays: null },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().agent.privateRetentionDays).toBeNull();
  });

  it("rejects out-of-range values and an agent belonging to a different owner", async () => {
    const owner = await insertTestOwner(t.db, "retention_range@example.com");
    const otherOwner = await insertTestOwner(t.db, "retention_other@example.com");
    const agent = await registerAndClaimFor(`retention_range_${newId("agt").slice(-6)}`, owner._id);
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const otherCookie = await createOwnerSessionCookie(t.db, otherOwner._id);
    const path = `/v1/owner/agents/${agent.agentId}/retention`;

    const tooLow = await app().inject({
      method: "PATCH",
      url: path,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { privateRetentionDays: 0 },
    });
    expect(tooLow.statusCode).toBe(400);

    const wrongOwner = await app().inject({
      method: "PATCH",
      url: path,
      headers: { cookie: otherCookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { privateRetentionDays: 30 },
    });
    expect(wrongOwner.statusCode).toBe(404);
  });
});

describe("PATCH /v1/owner/agents/{id}/visibility-default (realignment R4, docs/SPEC.md §15)", () => {
  it("fills in an omitted session visibility, without overriding an explicit request", async () => {
    const owner = await insertTestOwner(t.db, `visdef_${newId("own").slice(-6)}@example.com`);
    const counterpartyOwner = await insertTestOwner(t.db, `visdef_cp_${newId("own").slice(-6)}@example.com`);
    const initiator = await registerAndClaimFor(`visdef_init_${newId("agt").slice(-6)}`, owner._id);
    const counterparty = await registerAndClaimFor(`visdef_cp_${newId("agt").slice(-6)}`, counterpartyOwner._id);
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const server = app();

    const setRes = await server.inject({
      method: "PATCH",
      url: `/v1/owner/agents/${initiator.agentId}/visibility-default`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { defaultVisibility: "sealed" },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().agent.defaultVisibility).toBe("sealed");

    const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator, counterpartyAgentId: counterparty.agentId });
    const omittedBody = { offer, offerSignature }; // no `visibility` field at all
    const omittedHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: omittedBody, identity: initiator });
    const omittedRes = await server.inject({ method: "POST", url: "/v1/sessions", headers: omittedHeaders, payload: omittedBody });
    expect(omittedRes.statusCode).toBe(201);
    expect(omittedRes.json().session.visibility).toBe("sealed"); // agent default, not the platform's "shared"

    const { offer: offer2, offerSignature: offerSignature2 } = buildOffer({
      sessionId: newId("ses"),
      initiator,
      counterpartyAgentId: counterparty.agentId,
    });
    const explicitBody = { offer: offer2, offerSignature: offerSignature2, visibility: "shared" as const };
    const explicitHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: explicitBody, identity: initiator });
    const explicitRes = await server.inject({ method: "POST", url: "/v1/sessions", headers: explicitHeaders, payload: explicitBody });
    expect(explicitRes.statusCode).toBe(201);
    expect(explicitRes.json().session.visibility).toBe("shared"); // explicit request wins over the agent default

    const clearRes = await server.inject({
      method: "PATCH",
      url: `/v1/owner/agents/${initiator.agentId}/visibility-default`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { defaultVisibility: null },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().agent.defaultVisibility).toBeNull();
  });

  it("404s for an agent belonging to a different owner", async () => {
    const owner = await insertTestOwner(t.db, `visdef_other_${newId("own").slice(-6)}@example.com`);
    const stranger = await insertTestOwner(t.db, `visdef_stranger_${newId("own").slice(-6)}@example.com`);
    const agent = await registerAndClaimFor(`visdef_agent_${newId("agt").slice(-6)}`, owner._id);
    const strangerCookie = await createOwnerSessionCookie(t.db, stranger._id);

    const res = await app().inject({
      method: "PATCH",
      url: `/v1/owner/agents/${agent.agentId}/visibility-default`,
      headers: { cookie: strangerCookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { defaultVisibility: "shared" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/owner/attestations (realignment R4, docs/SPEC.md §15)", () => {
  async function openAttestation(server: ReturnType<typeof app>, attestor: TestAgentIdentity) {
    const { open, openSignature } = buildAttestationOpen({ attestationId: newId("att"), attestor });
    const body = { open, openSignature };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/attestations", body, identity: attestor });
    return server.inject({ method: "POST", url: "/v1/attestations", headers, payload: body });
  }

  it("lists only the caller's own attestations, filterable by status", async () => {
    const owner = await insertTestOwner(t.db, `att_owner_${newId("own").slice(-6)}@example.com`);
    const otherOwner = await insertTestOwner(t.db, `att_other_${newId("own").slice(-6)}@example.com`);
    const attestor = await registerAndClaimFor(`att_mine_${newId("agt").slice(-6)}`, owner._id);
    const otherAttestor = await registerAndClaimFor(`att_theirs_${newId("agt").slice(-6)}`, otherOwner._id);
    const server = app();

    const mineRes = await openAttestation(server, attestor);
    expect(mineRes.statusCode).toBe(201);
    const mineId = mineRes.json().attestation.id as string;
    const theirsRes = await openAttestation(server, otherAttestor);
    expect(theirsRes.statusCode).toBe(201);

    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const listRes = await server.inject({ method: "GET", url: "/v1/owner/attestations", headers: { cookie } });
    expect(listRes.statusCode).toBe(200);
    const ids = (listRes.json().items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(mineId);
    expect(ids).toHaveLength(1); // not the other owner's attestation

    const filteredRes = await server.inject({ method: "GET", url: "/v1/owner/attestations?status=active", headers: { cookie } });
    expect((filteredRes.json().items as { id: string }[]).map((i) => i.id)).toContain(mineId);

    const closedRes = await server.inject({ method: "GET", url: "/v1/owner/attestations?status=closed", headers: { cookie } });
    expect(closedRes.json().items).toHaveLength(0); // the attestation is still active, not closed
  });
});
