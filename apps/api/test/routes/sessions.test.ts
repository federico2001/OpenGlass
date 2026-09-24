import { newId } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import {
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

async function registerAndClaim(name: string) {
  const a = app();
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: "d", publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await a.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}@example.com`);
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return { identity, ownerId: owner._id };
}

function sessionId(): string {
  return newId("ses");
}

describe("POST /v1/sessions", () => {
  it("creates a direct-invite session offer targeting a known agent", async () => {
    const { identity: initiator } = await registerAndClaim("initiator1");
    const { identity: counterparty } = await registerAndClaim("counterparty1");
    const { offer, offerSignature } = buildOffer({ sessionId: sessionId(), initiator, counterpartyAgentId: counterparty.agentId });

    const body = { offer, offerSignature };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body, identity: initiator });
    const res = await app().inject({ method: "POST", url: "/v1/sessions", headers, payload: body });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.session.status).toBe("pending");
    expect(json.session.id).toBe(offer.sessionId);
    expect(json.invite.kind).toBe("direct");
    expect(json.invite.token).toBeNull();
  });

  it("creates an open invite (no counterparty) with a one-time token/url", async () => {
    const { identity: initiator } = await registerAndClaim("open_initiator");
    const { offer, offerSignature } = buildOffer({ sessionId: sessionId(), initiator, counterpartyAgentId: null });
    const body = { offer, offerSignature };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body, identity: initiator });
    const res = await app().inject({ method: "POST", url: "/v1/sessions", headers, payload: body });
    expect(res.statusCode).toBe(201);
    expect(res.json().invite.kind).toBe("open");
    expect(res.json().invite.token).toBeTruthy();
    expect(res.json().invite.url).toContain(res.json().invite.token);
  });

  it("rejects an offer from an unclaimed agent", async () => {
    const identity = testIdentity("unclaimed_x", "unclaimed_key_x");
    const regBody = { name: "Unclaimed", description: "d", publicKey: identity.publicKey };
    const regHeaders = signedRequestHeaders({ method: "POST", path: "/v1/agents", body: regBody, identity, selfSigned: true });
    const reg = await app().inject({ method: "POST", url: "/v1/agents", headers: regHeaders, payload: regBody });
    identity.agentId = reg.json().agent.id;
    identity.kid = reg.json().agent.keys[0].kid;

    const { offer, offerSignature } = buildOffer({ sessionId: sessionId(), initiator: identity });
    const body = { offer, offerSignature };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body, identity });
    const res = await app().inject({ method: "POST", url: "/v1/sessions", headers, payload: body });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("agent_unclaimed");
  });

  it("rejects a tampered offer signature", async () => {
    const { identity: initiator } = await registerAndClaim("tamper_initiator");
    const { offer, offerSignature } = buildOffer({ sessionId: sessionId(), initiator });
    offerSignature.sig = offerSignature.sig.slice(0, -4) + "AAAA";
    const body = { offer, offerSignature };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body, identity: initiator });
    const res = await app().inject({ method: "POST", url: "/v1/sessions", headers, payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("offer_invalid");
  });
});

describe("GET /v1/sessions/{id} access control", () => {
  it("is readable by both participants but not by an unrelated agent", async () => {
    const { identity: initiator } = await registerAndClaim("access_initiator");
    const { identity: counterparty } = await registerAndClaim("access_counterparty");
    const { identity: outsider } = await registerAndClaim("access_outsider");
    const { offer, offerSignature } = buildOffer({ sessionId: sessionId(), initiator, counterpartyAgentId: counterparty.agentId });
    const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: { offer, offerSignature }, identity: initiator });
    await app().inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: { offer, offerSignature } });

    const readAs = (id: typeof initiator) =>
      app().inject({ method: "GET", url: `/v1/sessions/${offer.sessionId}`, headers: signedRequestHeaders({ method: "GET", path: `/v1/sessions/${offer.sessionId}`, identity: id }) });

    expect((await readAs(initiator)).statusCode).toBe(200);
    expect((await readAs(counterparty)).statusCode).toBe(200);
    expect((await readAs(outsider)).statusCode).toBe(404);
  });
});

describe("POST /v1/sessions/{id}/cancel", () => {
  it("lets the initiator cancel a pending session, but only once", async () => {
    const { identity: initiator } = await registerAndClaim("cancel_initiator");
    const { offer, offerSignature } = buildOffer({ sessionId: sessionId(), initiator });
    const body = { offer, offerSignature };
    const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body, identity: initiator });
    await app().inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: body });

    const cancelPath = `/v1/sessions/${offer.sessionId}/cancel`;
    const cancelHeaders = signedRequestHeaders({ method: "POST", path: cancelPath, identity: initiator });
    const res = await app().inject({ method: "POST", url: cancelPath, headers: cancelHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json().session.status).toBe("cancelled");

    const again = await app().inject({ method: "POST", url: cancelPath, headers: signedRequestHeaders({ method: "POST", path: cancelPath, identity: initiator }) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("session_not_pending");
  });
});
