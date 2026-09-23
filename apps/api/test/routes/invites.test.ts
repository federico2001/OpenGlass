import { newId, ownersRepository } from "@openglass/db";
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
  for (const c of ["agents", "owners", "sessions", "invites", "request_nonces", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

async function registerAndClaim(name: string, requireInviteApproval = false) {
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}@example.com`);
  if (requireInviteApproval) {
    await ownersRepository(t.db).update(owner._id, { settings: { requireInviteApproval: true, emailOnRecord: true } });
  }
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return { identity, ownerId: owner._id };
}

async function offerSession(initiator: Awaited<ReturnType<typeof registerAndClaim>>["identity"], counterpartyAgentId?: string | null) {
  const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator, counterpartyAgentId });
  const body = { offer, offerSignature };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body, identity: initiator });
  const res = await app().inject({ method: "POST", url: "/v1/sessions", headers, payload: body });
  return { offer, offerSignature, inviteId: res.json().invite.id as string, token: res.json().invite.token as string | null };
}

describe("direct invite: end-to-end offer -> accept", () => {
  it("activates the session once the counterparty accepts", async () => {
    const { identity: initiator } = await registerAndClaim("d_initiator");
    const { identity: counterparty } = await registerAndClaim("d_counterparty");
    const { offer, inviteId } = await offerSession(initiator, counterparty.agentId);

    const getPath = `/v1/invites/${inviteId}`;
    const getRes = await app().inject({ method: "GET", url: getPath, headers: signedRequestHeaders({ method: "GET", path: getPath, identity: counterparty }) });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().offer.sessionId).toBe(offer.sessionId);

    const { accept, signature } = buildAccept({ offer, counterparty });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const acceptBody = { accept, signature };
    const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: counterparty });
    const acceptRes = await app().inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });

    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().session.status).toBe("active");
    expect(acceptRes.json().session.genesisHash).toBeTruthy();
    expect(acceptRes.json().invite.status).toBe("accepted");

    // a second accept on the same (now non-pending) invite must be rejected — with a
    // freshly-signed request, since headers/nonces are single-use and reusing them would
    // hit replay protection instead of the invite-state check this asserts on.
    const retryHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: counterparty });
    const again = await app().inject({ method: "POST", url: acceptPath, headers: retryHeaders, payload: acceptBody });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("invite_not_pending");
  });

  it("rejects an accept whose offerHash doesn't match the real offer", async () => {
    const { identity: initiator } = await registerAndClaim("bad_initiator");
    const { identity: counterparty } = await registerAndClaim("bad_counterparty");
    const { offer, inviteId } = await offerSession(initiator, counterparty.agentId);

    const { accept, signature } = buildAccept({ offer, counterparty });
    accept.offerHash = "0".repeat(64);
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const body = { accept, signature };
    const headers = signedRequestHeaders({ method: "POST", path: acceptPath, body, identity: counterparty });
    const res = await app().inject({ method: "POST", url: acceptPath, headers, payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("accept_invalid");
  });

  it("rejects accept attempts from an agent the invite wasn't addressed to", async () => {
    const { identity: initiator } = await registerAndClaim("addr_initiator");
    const { identity: counterparty } = await registerAndClaim("addr_counterparty");
    const { identity: outsider } = await registerAndClaim("addr_outsider");
    const { offer, inviteId } = await offerSession(initiator, counterparty.agentId);

    const { accept, signature } = buildAccept({ offer, counterparty: outsider });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const body = { accept, signature };
    const headers = signedRequestHeaders({ method: "POST", path: acceptPath, body, identity: outsider });
    const res = await app().inject({ method: "POST", url: acceptPath, headers, payload: body });
    expect(res.statusCode).toBe(404);
  });
});

describe("open invite: accept by bearer token", () => {
  it("lets any claimed agent with the token accept, except the initiator itself", async () => {
    const { identity: initiator } = await registerAndClaim("open_initiator2");
    const { identity: acceptor } = await registerAndClaim("open_acceptor");
    const { offer, inviteId, token } = await offerSession(initiator, null);
    expect(token).toBeTruthy();

    const { accept, signature } = buildAccept({ offer, counterparty: acceptor });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const body = { token, accept, signature };
    const headers = signedRequestHeaders({ method: "POST", path: acceptPath, body, identity: acceptor });
    const res = await app().inject({ method: "POST", url: acceptPath, headers, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe("active");
    expect(res.json().session.counterparty.agentId).toBe(acceptor.agentId);
  });

  it("rejects an accept with the wrong token", async () => {
    const { identity: initiator } = await registerAndClaim("open_initiator3");
    const { identity: acceptor } = await registerAndClaim("open_acceptor3");
    const { offer, inviteId } = await offerSession(initiator, null);

    const { accept, signature } = buildAccept({ offer, counterparty: acceptor });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const body = { token: "cl_wrong_token_value", accept, signature };
    const headers = signedRequestHeaders({ method: "POST", path: acceptPath, body, identity: acceptor });
    const res = await app().inject({ method: "POST", url: acceptPath, headers, payload: body });
    expect(res.statusCode).toBe(404);
  });
});

describe("owner approval gate (D5)", () => {
  it("holds the session pending until the owner setting requires approval", async () => {
    const { identity: initiator } = await registerAndClaim("appr_initiator");
    const { identity: counterparty } = await registerAndClaim("appr_counterparty", true);
    const { offer, inviteId } = await offerSession(initiator, counterparty.agentId);

    const { accept, signature } = buildAccept({ offer, counterparty });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const body = { accept, signature };
    const headers = signedRequestHeaders({ method: "POST", path: acceptPath, body, identity: counterparty });
    const res = await app().inject({ method: "POST", url: acceptPath, headers, payload: body });

    expect(res.statusCode).toBe(202);
    expect(res.json().invite.status).toBe("awaiting_owner");
    expect(res.json().session.status).toBe("pending");
    expect(res.json().session.genesisHash).toBeNull();
  });
});

describe("POST /v1/invites/{id}/decline", () => {
  it("declines a pending direct invite", async () => {
    const { identity: initiator } = await registerAndClaim("decl_initiator");
    const { identity: counterparty } = await registerAndClaim("decl_counterparty");
    const { inviteId } = await offerSession(initiator, counterparty.agentId);

    const declinePath = `/v1/invites/${inviteId}/decline`;
    const headers = signedRequestHeaders({ method: "POST", path: declinePath, body: {}, identity: counterparty });
    const res = await app().inject({ method: "POST", url: declinePath, headers, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().invite.status).toBe("declined");
    expect(res.json().session.status).toBe("declined");
  });
});
