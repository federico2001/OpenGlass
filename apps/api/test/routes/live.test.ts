import { agentsRepository, newId, ownersRepository } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import {
  buildAccept,
  buildAttestationOpen,
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

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "attestations", "fetch_witnesses", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function app(overrides: Partial<ReturnType<typeof testServerDeps>> = {}) {
  return buildServer({ ...testServerDeps(t), healthChecks: {}, ...overrides });
}

async function registerAndClaimFor(name: string, ownerId: string) {
  const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
  const body = { name, description: `${name} description`, publicKey: identity.publicKey };
  const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
  const res = await app().inject({ method: "POST", url: "/v1/agents", headers, payload: body });
  identity.agentId = res.json().agent.id;
  identity.kid = res.json().agent.keys[0].kid;
  await claimAgentDirectly(t.db, identity.agentId, ownerId);
  return identity;
}

describe("GET /v1/live", () => {
  it("is empty when no owner has opted in", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stats: { activeAgents: 0, totalRecords: 0, publicSessions: 0 }, items: [], nextCursor: null });
  });

  it("surfaces messages only once both owners have opted in", async () => {
    const ownerA = await insertTestOwner(t.db, "feed-a@example.com");
    const ownerB = await insertTestOwner(t.db, "feed-b@example.com");
    const a = await registerAndClaimFor(`feed_a_${newId("agt").slice(-6)}`, ownerA._id);
    const b = await registerAndClaimFor(`feed_b_${newId("agt").slice(-6)}`, ownerB._id);

    const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator: a, counterpartyAgentId: b.agentId });
    const createBody = { offer, offerSignature };
    const createHeaders = signedRequestHeaders({ method: "POST", path: "/v1/sessions", body: createBody, identity: a });
    const createRes = await app().inject({ method: "POST", url: "/v1/sessions", headers: createHeaders, payload: createBody });
    const { accept, signature } = buildAccept({ offer, counterparty: b });
    const acceptPath = `/v1/invites/${createRes.json().invite.id}/accept`;
    const acceptBody = { accept, signature };
    const acceptHeaders = signedRequestHeaders({ method: "POST", path: acceptPath, body: acceptBody, identity: b });
    const acceptRes = await app().inject({ method: "POST", url: acceptPath, headers: acceptHeaders, payload: acceptBody });
    const genesisHash = acceptRes.json().session.genesisHash as string;

    const msgBody = { text: "The agreed price is $17.25." };
    const { envelope, hash, signature: msgSig } = buildMessage({
      sessionId: offer.sessionId,
      seq: 1,
      prevHash: genesisHash,
      sender: a,
      mode: "relay",
      payload: msgBody,
    });
    const sendPath = `/v1/sessions/${offer.sessionId}/messages`;
    const sendBody = { envelope, hash, signature: msgSig, payload: msgBody };
    const sendHeaders = signedRequestHeaders({ method: "POST", path: sendPath, body: sendBody, identity: a });
    const sendRes = await app().inject({ method: "POST", url: sendPath, headers: sendHeaders, payload: sendBody });
    expect(sendRes.statusCode).toBe(201);

    // Neither owner has opted in yet — nothing shows.
    const before = await app().inject({ method: "GET", url: "/v1/live" });
    expect(before.json().items).toEqual([]);
    expect(before.json().stats.publicSessions).toBe(0);

    // Only one owner opts in — still nothing (both sides must consent).
    await ownersRepository(t.db).update(ownerA._id, { settings: { requireInviteApproval: false, emailOnRecord: true, publicFeedOptIn: true } });
    const halfOptedIn = await app().inject({ method: "GET", url: "/v1/live" });
    expect(halfOptedIn.json().items).toEqual([]);

    // Both owners opt in — the message appears.
    await ownersRepository(t.db).update(ownerB._id, { settings: { requireInviteApproval: false, emailOnRecord: true, publicFeedOptIn: true } });
    const after = await app().inject({ method: "GET", url: "/v1/live" });
    expect(after.statusCode).toBe(200);
    expect(after.json().stats.publicSessions).toBe(1);
    expect(after.json().items).toHaveLength(1);
    expect(after.json().items[0]).toMatchObject({
      sessionId: offer.sessionId,
      seq: 1,
      senderAgentId: a.agentId,
      text: "The agreed price is $17.25.",
      hash,
    });
  });
});

describe("GET /v1/live stats.activeAgents (docs/SPEC.md §12.6)", () => {
  const fakeWitnessFetch = async () => ({
    ok: true as const,
    response: { status: 200, headers: {}, contentType: "text/plain", bodySha256: "a".repeat(64), bodyBytes: 5, bodyTruncated: false, bodyText: "hi" },
  });

  async function openAttestationFor(attestor: TestAgentIdentity, server: ReturnType<typeof app>): Promise<string> {
    const { open, openSignature } = buildAttestationOpen({ attestationId: newId("att"), attestor });
    const body = { open, openSignature };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/attestations", body, identity: attestor });
    const res = await server.inject({ method: "POST", url: "/v1/attestations", headers, payload: body });
    return res.json().attestation.id as string;
  }

  async function witnessFetch(attestor: TestAgentIdentity, attestationId: string, url: string, server: ReturnType<typeof app>) {
    const path = `/v1/attestations/${attestationId}/witness-fetch`;
    const body = { url };
    const headers = signedRequestHeaders({ method: "POST", path, body, identity: attestor });
    return server.inject({ method: "POST", url: path, headers, payload: body });
  }

  it("counts a witnessed external domain once, even across repeated and multi-attestation fetches", async () => {
    const owner = await insertTestOwner(t.db, `wfx-live-${newId("own").slice(-6)}@example.com`);
    const attestor = await registerAndClaimFor(`wfx_live_${newId("agt").slice(-6)}`, owner._id);
    const server = app({ performWitnessFetch: fakeWitnessFetch });

    const before = await server.inject({ method: "GET", url: "/v1/live" });
    expect(before.json().stats.activeAgents).toBe(1); // just the registered attestor

    const att1 = await openAttestationFor(attestor, server);
    await witnessFetch(attestor, att1, "https://counterparty-a.example/offer", server);
    const afterOne = await server.inject({ method: "GET", url: "/v1/live" });
    expect(afterOne.json().stats.activeAgents).toBe(2); // + the one external domain

    // Same domain again, from a second attestation — still only +1 overall.
    const att2 = await openAttestationFor(attestor, server);
    await witnessFetch(attestor, att2, "https://counterparty-a.example/accept", server);
    const afterTwo = await server.inject({ method: "GET", url: "/v1/live" });
    expect(afterTwo.json().stats.activeAgents).toBe(2);
  });

  it("doesn't double-count a witnessed domain that's already a registered agent's own homepage", async () => {
    const owner = await insertTestOwner(t.db, `wfx-live-dup-${newId("own").slice(-6)}@example.com`);
    const attestor = await registerAndClaimFor(`wfx_dup_a_${newId("agt").slice(-6)}`, owner._id);
    const server = app({ performWitnessFetch: fakeWitnessFetch });

    const name = `wfx_dup_b_${newId("agt").slice(-6)}`;
    const identity = testIdentity(`placeholder_${name}`, `placeholder_key_${name}`);
    const body = { name, description: "has its own homepage", publicKey: identity.publicKey, meta: { homepage: "https://counterparty-b.example" } };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity, selfSigned: true });
    const res = await server.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    await claimAgentDirectly(t.db, res.json().agent.id, owner._id);

    const attestationId = await openAttestationFor(attestor, server);
    await witnessFetch(attestor, attestationId, "https://counterparty-b.example/offer", server);

    const after = await server.inject({ method: "GET", url: "/v1/live" });
    // 2 registered agents (attestor + the one with counterparty-b.example as its own
    // homepage), 0 extra — the witnessed domain is already counted as a registered agent.
    expect(after.json().stats.activeAgents).toBe(2);
  });
});

describe("GET /v1/directory", () => {
  it("only lists agents whose owner opted into the public directory", async () => {
    const owner = await insertTestOwner(t.db, "dir-owner@example.com");
    const listed = await registerAndClaimFor(`dir_listed_${newId("agt").slice(-6)}`, owner._id);
    const unlisted = await registerAndClaimFor(`dir_unlisted_${newId("agt").slice(-6)}`, owner._id);
    void unlisted;

    const before = await app().inject({ method: "GET", url: "/v1/directory" });
    expect(before.json().items).toEqual([]);

    await agentsRepository(t.db).update(listed.agentId, { publicDirectory: true });
    const after = await app().inject({ method: "GET", url: "/v1/directory" });
    expect(after.json().items.map((i: { id: string }) => i.id)).toEqual([listed.agentId]);
  });

  it("filters by search text and the verified flag", async () => {
    const owner = await insertTestOwner(t.db, "dir-search@example.com");
    const alice = await registerAndClaimFor(`Alice_Negotiator_${newId("agt").slice(-6)}`, owner._id);
    const bob = await registerAndClaimFor(`Bob_Verified_${newId("agt").slice(-6)}`, owner._id);
    await agentsRepository(t.db).update(alice.agentId, { publicDirectory: true });
    await agentsRepository(t.db).update(bob.agentId, { publicDirectory: true, verifiedBadge: true });

    const searchRes = await app().inject({ method: "GET", url: "/v1/directory?q=Alice_Negotiator" });
    expect(searchRes.json().items.map((i: { id: string }) => i.id)).toEqual([alice.agentId]);

    const verifiedRes = await app().inject({ method: "GET", url: "/v1/directory?verified=true" });
    expect(verifiedRes.json().items.map((i: { id: string }) => i.id)).toEqual([bob.agentId]);
  });
});

describe("PATCH /v1/owner/agents/:agentId", () => {
  it("lets the owner toggle their own agent's directory listing, no one else's", async () => {
    const owner = await insertTestOwner(t.db, "toggle-owner@example.com");
    const otherOwner = await insertTestOwner(t.db, "toggle-other@example.com");
    const agent = await registerAndClaimFor(`toggle_${newId("agt").slice(-6)}`, owner._id);
    const cookie = await createOwnerSessionCookie(t.db, owner._id);

    const res = await app().inject({
      method: "PATCH",
      url: `/v1/owner/agents/${agent.agentId}`,
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { publicDirectory: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent.publicDirectory).toBe(true);

    const otherCookie = await createOwnerSessionCookie(t.db, otherOwner._id);
    const forbidden = await app().inject({
      method: "PATCH",
      url: `/v1/owner/agents/${agent.agentId}`,
      headers: { cookie: otherCookie, origin: "https://localhost", "content-type": "application/json" },
      payload: { publicDirectory: false },
    });
    expect(forbidden.statusCode).toBe(404);
  });
});
