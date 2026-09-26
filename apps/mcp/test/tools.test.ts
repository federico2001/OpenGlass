import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newId } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../packages/db/test/testDb.js";
import { buildServer as buildApiServer } from "../../api/src/server.js";
import {
  buildAccept,
  buildAttestationOpen,
  buildOffer,
  claimAgentDirectly,
  insertTestOwner,
  signedRequestHeaders,
  testIdentity,
  testServerDeps,
  type TestAgentIdentity,
} from "../../api/test/helpers.js";
import { buildServer as buildMcpServer } from "../src/server.js";

/**
 * Real end-to-end test of the MCP layer: a genuine MCP `Client` over the real
 * StreamableHTTP transport, talking to a real running apps/mcp server, which proxies to
 * a real running apps/api server backed by a real (testcontainers) Mongo. Nothing here
 * is mocked — this is the same MCP protocol a real agent's tool-calling runtime would use.
 */

let t: Awaited<ReturnType<typeof openTestDb>>;
let apiApp: ReturnType<typeof buildApiServer>;
let mcpApp: ReturnType<typeof buildMcpServer>;
let client: Client;

beforeAll(async () => {
  t = await openTestDb();
  const deps = testServerDeps(t);
  apiApp = buildApiServer({ ...deps, healthChecks: {} });
  await apiApp.listen({ host: "127.0.0.1", port: 0 });
  const apiAddr = apiApp.server.address();
  if (!apiAddr || typeof apiAddr === "string") throw new Error("api did not bind to a port");

  mcpApp = buildMcpServer({ apiInternalUrl: `http://127.0.0.1:${apiAddr.port}` });
  await mcpApp.listen({ host: "127.0.0.1", port: 0 });
  const mcpAddr = mcpApp.server.address();
  if (!mcpAddr || typeof mcpAddr === "string") throw new Error("mcp did not bind to a port");

  client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpAddr.port}/mcp`));
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await mcpApp.close();
  await apiApp.close();
  await t.cleanup();
});

beforeEach(async () => {
  for (const c of ["agents", "owners", "sessions", "invites", "messages", "attestations", "request_nonces", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function auth(identity: TestAgentIdentity, opts: { method: string; path: string; body?: unknown; selfSigned?: boolean }) {
  const h = signedRequestHeaders({ method: opts.method, path: opts.path, body: opts.body, identity, selfSigned: opts.selfSigned });
  return {
    ...(opts.selfSigned ? {} : { agentId: identity.agentId }),
    kid: h["og-key"]!,
    timestamp: h["og-timestamp"]!,
    nonce: h["og-nonce"]!,
    sig: h["og-signature"]!,
  };
}

function toolJson(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const block = (result.content as { type: string; text: string }[])[0];
  if (!block || block.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(block.text);
}

async function registerAndClaim(name: string): Promise<TestAgentIdentity> {
  const identity = testIdentity(`ph_${name}`, `ph_key_${name}`);
  const body = { name, description: "MCP test agent", publicKey: identity.publicKey };
  const result = await client.callTool({
    name: "register_agent",
    arguments: { ...body, auth: auth(identity, { method: "POST", path: "/v1/agents", body, selfSigned: true }) },
  });
  expect(result.isError).toBeFalsy();
  const json = toolJson(result);
  identity.agentId = json.agent.id;
  identity.kid = json.agent.keys[0].kid;
  const owner = await insertTestOwner(t.db, `${name}@example.com`);
  await claimAgentDirectly(t.db, identity.agentId, owner._id);
  return identity;
}

describe("MCP tools end-to-end over the real StreamableHTTP protocol", () => {
  it("lists all 12 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "accept_invite",
        "close_attestation",
        "close_session",
        "get_record",
        "invite_counterparty",
        "open_attestation",
        "pause_session",
        "register_agent",
        "send_attestation_event",
        "send_message",
        "start_session",
        "verify_agent",
      ].sort(),
    );
  });

  it("register_agent registers a real agent via the real API", async () => {
    const identity = testIdentity("reg_probe", "reg_probe_key");
    const body = { name: "Probe", description: "d", publicKey: identity.publicKey };
    const result = await client.callTool({
      name: "register_agent",
      arguments: { ...body, auth: auth(identity, { method: "POST", path: "/v1/agents", body, selfSigned: true }) },
    });
    expect(result.isError).toBeFalsy();
    const json = toolJson(result);
    expect(json.agent.status).toBe("unclaimed");
    expect(json.claim.token).toBeTruthy();
  });

  it("full session lifecycle via MCP tools: offer -> accept -> message -> close", async () => {
    const alice = await registerAndClaim("alice");
    const bob = await registerAndClaim("bob");

    const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator: alice, counterpartyAgentId: bob.agentId });
    const offerBody = { offer, offerSignature };
    const startResult = await client.callTool({
      name: "invite_counterparty",
      arguments: { ...offerBody, auth: auth(alice, { method: "POST", path: "/v1/sessions", body: offerBody }) },
    });
    expect(startResult.isError).toBeFalsy();
    const started = toolJson(startResult);
    const inviteId = started.invite.id as string;

    const preparePath = `/v1/invites/${inviteId}`;
    const prepareResult = await client.callTool({
      name: "accept_invite",
      arguments: { mode: "prepare", inviteId, auth: auth(bob, { method: "GET", path: preparePath }) },
    });
    expect(prepareResult.isError).toBeFalsy();
    const prepared = toolJson(prepareResult);
    expect(prepared.offerHash).toBeTruthy();

    const { accept, signature: acceptSig } = buildAccept({ offer, counterparty: bob });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const acceptBody = { accept, signature: acceptSig };
    const acceptResult = await client.callTool({
      name: "accept_invite",
      arguments: { mode: "submit", inviteId, accept, signature: acceptSig, auth: auth(bob, { method: "POST", path: acceptPath, body: acceptBody }) },
    });
    expect(acceptResult.isError).toBeFalsy();
    const accepted = toolJson(acceptResult);
    expect(accepted.session.status).toBe("active");
    const sessionId = accepted.session.id as string;

    const msgPreparePath = `/v1/sessions/${sessionId}`;
    const msgPrepareResult = await client.callTool({
      name: "send_message",
      arguments: { mode: "prepare", sessionId, auth: auth(alice, { method: "GET", path: msgPreparePath }) },
    });
    const msgPrepared = toolJson(msgPrepareResult);
    expect(msgPrepared.nextSeq).toBe(1);
    expect(msgPrepared.prevHash).toBe(accepted.session.genesisHash);

    // sign the actual envelope using the same helper the API-level tests use (via a
    // throwaway session object with just enough shape for buildOffer/buildAccept-style signing)
    const { canonicalizeToBytes, sha256, hex, signEd25519, sigInput, base64UrlEncode } = await import("@openglass/db");
    const payload = { text: "hello from MCP" };
    const payloadHash = hex(sha256(canonicalizeToBytes(payload)));
    const envelope = {
      v: 1 as const,
      type: "openglass.message" as const,
      sessionId,
      seq: 1,
      prevHash: msgPrepared.prevHash,
      sender: { agentId: alice.agentId, kid: alice.kid },
      contentType: "application/json",
      payloadHash,
      sentAt: new Date().toISOString(),
    };
    const hashBytes = sha256(Buffer.concat([Buffer.from(msgPrepared.prevHash, "hex"), canonicalizeToBytes(envelope)]));
    const hash = hex(hashBytes);
    const signature = { alg: "Ed25519" as const, kid: alice.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), alice.privateKey)) };
    const msgSubmitPath = `/v1/sessions/${sessionId}/messages`;
    const msgSubmitBody = { envelope, hash, signature, payload };
    const msgSubmitResult = await client.callTool({
      name: "send_message",
      arguments: { mode: "submit", sessionId, envelope, hash, signature, payload, auth: auth(alice, { method: "POST", path: msgSubmitPath, body: msgSubmitBody }) },
    });
    expect(msgSubmitResult.isError).toBeFalsy();
    expect(toolJson(msgSubmitResult).head.seq).toBe(1);

    const closePreparePath = `/v1/sessions/${sessionId}`;
    const closePrepareResult = await client.callTool({
      name: "close_session",
      arguments: { mode: "prepare", sessionId, auth: auth(alice, { method: "GET", path: closePreparePath }) },
    });
    const closePrepared = toolJson(closePrepareResult);
    expect(closePrepared.headSeq).toBe(1);

    const statement = { v: 1 as const, type: "openglass.close" as const, sessionId, headSeq: closePrepared.headSeq, headHash: closePrepared.headHash, closedAt: new Date().toISOString() };
    const closeSig = { alg: "Ed25519" as const, kid: alice.kid, sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), alice.privateKey)) };
    const closeSubmitPath = `/v1/sessions/${sessionId}/close`;
    const closeSubmitBody = { statement, signature: closeSig };
    const closeSubmitResult = await client.callTool({
      name: "close_session",
      arguments: { mode: "submit", sessionId, statement, signature: closeSig, auth: auth(alice, { method: "POST", path: closeSubmitPath, body: closeSubmitBody }) },
    });
    expect(closeSubmitResult.isError).toBeFalsy();
    expect(toolJson(closeSubmitResult).session.status).toBe("closing");
  });

  it("pause_session pauses an active session for the owner's review", async () => {
    const carol = await registerAndClaim("carol");
    const dave = await registerAndClaim("dave");

    const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator: carol, counterpartyAgentId: dave.agentId });
    const offerBody = { offer, offerSignature };
    const startResult = await client.callTool({
      name: "invite_counterparty",
      arguments: { ...offerBody, auth: auth(carol, { method: "POST", path: "/v1/sessions", body: offerBody }) },
    });
    const inviteId = toolJson(startResult).invite.id as string;

    const { accept, signature: acceptSig } = buildAccept({ offer, counterparty: dave });
    const acceptPath = `/v1/invites/${inviteId}/accept`;
    const acceptBody = { accept, signature: acceptSig };
    const acceptResult = await client.callTool({
      name: "accept_invite",
      arguments: { mode: "submit", inviteId, accept, signature: acceptSig, auth: auth(dave, { method: "POST", path: acceptPath, body: acceptBody }) },
    });
    const sessionId = toolJson(acceptResult).session.id as string;

    const pausePath = `/v1/sessions/${sessionId}/pause`;
    const pauseBody = { reason: "Checking the terms with my owner first" };
    const pauseResult = await client.callTool({
      name: "pause_session",
      arguments: { sessionId, reason: pauseBody.reason, auth: auth(carol, { method: "POST", path: pausePath, body: pauseBody }) },
    });
    expect(pauseResult.isError).toBeFalsy();
    const paused = toolJson(pauseResult);
    expect(paused.session.status).toBe("paused");
    expect(paused.session.pause.requestedBy).toBe(carol.agentId);
    expect(paused.session.pause.reason).toBe(pauseBody.reason);
  });

  it("full attestation lifecycle via MCP tools: open -> event -> close", async () => {
    const erin = await registerAndClaim("erin");
    const { canonicalizeToBytes, sha256, hex, signEd25519, sigInput, base64UrlEncode } = await import("@openglass/db");

    const attestationId = newId("att");
    const { open, openSignature } = buildAttestationOpen({ attestationId, attestor: erin });
    const openBody = { open, openSignature, idleTimeoutSec: undefined };
    const openResult = await client.callTool({
      name: "open_attestation",
      arguments: { open, openSignature, auth: auth(erin, { method: "POST", path: "/v1/attestations", body: openBody }) },
    });
    expect(openResult.isError).toBeFalsy();
    const opened = toolJson(openResult);
    expect(opened.attestation.status).toBe("active");

    const eventPreparePath = `/v1/attestations/${attestationId}`;
    const eventPrepareResult = await client.callTool({
      name: "send_attestation_event",
      arguments: { mode: "prepare", attestationId, auth: auth(erin, { method: "GET", path: eventPreparePath }) },
    });
    expect(eventPrepareResult.isError).toBeFalsy();
    const eventPrepared = toolJson(eventPrepareResult);
    expect(eventPrepared.nextSeq).toBe(1);
    expect(eventPrepared.prevHash).toBe(opened.attestation.genesisHash);

    const payload = { text: "logging a high-risk tool call" };
    const payloadHash = hex(sha256(canonicalizeToBytes(payload)));
    const envelope = {
      v: 1 as const,
      type: "openglass.message" as const,
      sessionId: attestationId,
      seq: 1,
      prevHash: eventPrepared.prevHash,
      sender: { agentId: erin.agentId, kid: erin.kid },
      contentType: "application/json",
      payloadHash,
      sentAt: new Date().toISOString(),
    };
    const hashBytes = sha256(Buffer.concat([Buffer.from(eventPrepared.prevHash, "hex"), canonicalizeToBytes(envelope)]));
    const hash = hex(hashBytes);
    const signature = { alg: "Ed25519" as const, kid: erin.kid, sig: base64UrlEncode(signEd25519(sigInput("message", hashBytes), erin.privateKey)) };
    const eventSubmitPath = `/v1/attestations/${attestationId}/events`;
    const eventSubmitBody = { envelope, hash, signature, payload };
    const eventSubmitResult = await client.callTool({
      name: "send_attestation_event",
      arguments: { mode: "submit", attestationId, envelope, hash, signature, payload, auth: auth(erin, { method: "POST", path: eventSubmitPath, body: eventSubmitBody }) },
    });
    expect(eventSubmitResult.isError).toBeFalsy();
    expect(toolJson(eventSubmitResult).head.seq).toBe(1);

    const closePreparePath = `/v1/attestations/${attestationId}`;
    const closePrepareResult = await client.callTool({
      name: "close_attestation",
      arguments: { mode: "prepare", attestationId, auth: auth(erin, { method: "GET", path: closePreparePath }) },
    });
    const closePrepared = toolJson(closePrepareResult);
    expect(closePrepared.headSeq).toBe(1);

    const statement = {
      v: 1 as const,
      type: "openglass.close" as const,
      sessionId: attestationId,
      headSeq: closePrepared.headSeq,
      headHash: closePrepared.headHash,
      closedAt: new Date().toISOString(),
    };
    const closeSig = { alg: "Ed25519" as const, kid: erin.kid, sig: base64UrlEncode(signEd25519(sigInput("close", sha256(canonicalizeToBytes(statement))), erin.privateKey)) };
    const closeSubmitPath = `/v1/attestations/${attestationId}/close`;
    const closeSubmitBody = { statement, signature: closeSig };
    const closeSubmitResult = await client.callTool({
      name: "close_attestation",
      arguments: { mode: "submit", attestationId, statement, signature: closeSig, auth: auth(erin, { method: "POST", path: closeSubmitPath, body: closeSubmitBody }) },
    });
    expect(closeSubmitResult.isError).toBeFalsy();
    expect(toolJson(closeSubmitResult).attestation.status).toBe("closing");
  });

  it("invite_counterparty rejects a nonexistent counterparty before ever calling POST /v1/sessions", async () => {
    const alice = await registerAndClaim("alice2");
    const { offer, offerSignature } = buildOffer({ sessionId: newId("ses"), initiator: alice, counterpartyAgentId: "agt_00000000000000000000000000" });
    const body = { offer, offerSignature };
    const result = await client.callTool({
      name: "invite_counterparty",
      arguments: { ...body, auth: auth(alice, { method: "POST", path: "/v1/sessions", body }) },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("not found");
  });

  it("verify_agent looks up a public agent profile", async () => {
    const alice = await registerAndClaim("alice3");
    const result = await client.callTool({ name: "verify_agent", arguments: { agentId: alice.agentId } });
    expect(result.isError).toBeFalsy();
    expect(toolJson(result).agent.id).toBe(alice.agentId);
  });

  it("verify_agent rejects a bundle signed by an untrusted platform key", async () => {
    const { buildTestBundle } = await import("../../../packages/db/test/crypto/buildTestBundle.js");
    const { bundle } = await buildTestBundle();
    const result = await client.callTool({ name: "verify_agent", arguments: { bundle } });
    expect(result.isError).toBeFalsy();
    const json = toolJson(result);
    expect(json.valid).toBe(false);
  });

  it("verify_agent rejects when both or neither of agentId/bundle are given", async () => {
    const neither = await client.callTool({ name: "verify_agent", arguments: {} });
    expect(neither.isError).toBe(true);
  });
});
