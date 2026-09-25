import {
  agentsRepository,
  base64UrlDecode,
  canonicalizeToBytes,
  IsoTimestamp,
  newId,
  PublicKey,
  sessionsRepository,
  sha256,
  verifySignature,
  type AgentDoc,
} from "@openglass/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentFullView, agentPublicView, domainVerificationView, keyView } from "../domain/agentViews.js";
import { domainFromHomepage, generateVerificationToken, verificationFileUrl } from "../domain/domainVerification.js";
import { keyFingerprint } from "../domain/fingerprint.js";
import { generateToken, hashToken } from "../domain/tokens.js";
import { parseOrError, sendError } from "../errors.js";
import { verifyAgentRequest } from "../plugins/agentAuth.js";
import { rateLimit } from "../plugins/rateLimit.js";
import type { ServerDeps } from "../server.js";

const CLAIM_TOKEN_TTL_MS = 24 * 3_600_000;

const Meta = z.strictObject({ homepage: z.string().max(512).optional(), software: z.string().max(100).optional() });

const RegisterBody = z.strictObject({
  name: z.string().min(1).max(100),
  description: z.string().max(1000),
  publicKey: PublicKey,
  meta: Meta.optional(),
});

const PatchBody = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  meta: Meta.optional(),
});

const AddKeyBody = z.strictObject({
  publicKey: PublicKey,
  createdAt: IsoTimestamp,
  proof: z.strictObject({ alg: z.literal("Ed25519"), kid: z.literal("new"), sig: z.string() }),
});

/**
 * A per-agent counterpart to the platform-level card at `/.well-known/agent.json`
 * (routes/wellKnown.ts — see that file's doc comment for why `skills`/`capabilities` are
 * informational rather than true A2A-invocable fields here too). OpenGlass has no
 * endpoint of its own to reach a specific agent at — agents connect out to OpenGlass, not
 * the other way around — so `url` points at the agent's own advertised homepage when it
 * has one, falling back to its OpenGlass profile. `version` similarly comes from whatever
 * the agent told OpenGlass at registration (`meta.software`, e.g. "acme-agent/2.3"), not
 * a value OpenGlass invents. `skills` is left empty: OpenGlass has no way to know what a
 * given agent actually does.
 */
function agentCardFor(agent: AgentDoc, deps: ServerDeps) {
  const activeKeys = agent.keys.filter((k) => !k.revokedAt);
  const primaryKey = activeKeys[0] ?? agent.keys[0]!;
  const profileUrl = `${deps.publicUrl}/v1/agents/${agent._id}`;
  return {
    name: agent.name,
    description: agent.description || "A software agent registered on OpenGlass, a neutral witness for agent-to-agent interactions.",
    version: agent.meta.software ?? "0.0.0",
    url: agent.meta.homepage ?? profileUrl,
    provider: { organization: agent.name },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [],
    "x-openglass": {
      agentId: agent._id,
      status: agent.status,
      claimed: agent.ownerId !== null,
      verifiedBadge: agent.verifiedBadge ?? false,
      domainVerified: agent.domainVerification?.status === "verified",
      fingerprint: keyFingerprint(primaryKey.publicKey),
      keys: activeKeys.map((k) => ({ kid: k.kid, alg: k.alg, publicKey: k.publicKey })),
      profileUrl,
      platformAgentCardUrl: `${deps.publicUrl}/.well-known/agent.json`,
    },
  };
}

export function registerAgentsRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const agents = agentsRepository(deps.db);
  const sessions = sessionsRepository(deps.db);

  app.post(
    "/v1/agents",
    { preHandler: [rateLimit(deps.db, "agent_register", (req) => req.ip), verifyAgentRequest(deps.db, { selfSigned: true })] },
    async (req, reply) => {
      const body = parseOrError(RegisterBody, req.body, reply);
      if (!body) return;

      if (await agents.findByPublicKey(body.publicKey)) {
        return sendError(reply, 409, "key_in_use", "This public key is already registered to an agent");
      }

      const now = new Date();
      const agentId = newId("agt");
      const kid = newId("key");
      const token = generateToken(24);
      const claim = { tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + CLAIM_TOKEN_TTL_MS) };

      const doc = await agents.insert({
        _id: agentId,
        name: body.name,
        description: body.description,
        meta: body.meta ?? {},
        keys: [{ kid, alg: "Ed25519", publicKey: body.publicKey, createdAt: now, revokedAt: null }],
        ownerId: null,
        status: "unclaimed",
        claim,
        claimedAt: null,
        suspendedAt: null,
        createdAt: now,
        updatedAt: now,
        verifiedBadge: false,
      });

      return reply.code(201).send({
        agent: agentFullView(doc),
        claim: { token, url: `${deps.publicUrl}/claim/${token}`, expiresAt: claim.expiresAt.toISOString() },
      });
    },
  );

  app.get("/v1/agents/me", { preHandler: verifyAgentRequest(deps.db) }, async (req) => ({ agent: agentFullView(req.agent!.doc) }));

  app.patch("/v1/agents/me", { preHandler: verifyAgentRequest(deps.db) }, async (req, reply) => {
    const body = parseOrError(PatchBody, req.body, reply);
    if (!body) return;
    const agent = req.agent!.doc;
    // A domain verification proves control of one specific domain — if meta.homepage is
    // changing, it no longer applies to whatever homepage comes next.
    const homepageChanged = body.meta !== undefined && body.meta.homepage !== agent.meta.homepage;
    const updated = await agents.update(agent._id, { ...body, ...(homepageChanged ? { domainVerification: null } : {}) });
    return { agent: agentFullView(updated!) };
  });

  app.post(
    "/v1/agents/me/domain-verification",
    { preHandler: [verifyAgentRequest(deps.db), rateLimit(deps.db, "domain_verification", (req) => req.agent!.doc._id)] },
    async (req, reply) => {
      const agent = req.agent!.doc;
      const domain = domainFromHomepage(agent.meta.homepage);
      if (!domain) {
        return sendError(
          reply,
          422,
          "domain_invalid",
          "meta.homepage must be set to a real https:// URL (not an IP address or localhost) before requesting domain verification",
        );
      }
      const token = generateVerificationToken();
      const domainVerification = { domain, token, status: "pending" as const, requestedAt: new Date(), verifiedAt: null };
      const updated = await agents.update(agent._id, { domainVerification });
      return reply.code(201).send({
        domainVerification: domainVerificationView(updated!.domainVerification!),
        verifyUrl: verificationFileUrl(domain),
        instructions: `Publish a file at ${verificationFileUrl(domain)} whose contents are exactly this token, on its own line: ${token}`,
      });
    },
  );

  app.post(
    "/v1/agents/me/domain-verification/check",
    { preHandler: [verifyAgentRequest(deps.db), rateLimit(deps.db, "domain_verification", (req) => req.agent!.doc._id)] },
    async (req, reply) => {
      const agent = req.agent!.doc;
      const dv = agent.domainVerification ?? null;
      if (!dv) return sendError(reply, 409, "domain_verification_not_requested", "Call POST /v1/agents/me/domain-verification first");
      if (dv.status === "verified") return { domainVerification: domainVerificationView(dv) };

      const ok = await deps.checkDomainVerification(dv.domain, dv.token);
      if (!ok) {
        return sendError(reply, 422, "domain_verification_failed", `Could not find the verification token at ${verificationFileUrl(dv.domain)}`);
      }
      const updated = await agents.update(agent._id, { domainVerification: { ...dv, status: "verified", verifiedAt: new Date() } });
      return { domainVerification: domainVerificationView(updated!.domainVerification!) };
    },
  );

  app.post("/v1/agents/me/claim-token", { preHandler: verifyAgentRequest(deps.db) }, async (req, reply) => {
    const agent = req.agent!.doc;
    if (agent.status !== "unclaimed") return sendError(reply, 409, "already_claimed", "Agent is already claimed");
    const token = generateToken(24);
    const expiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_MS);
    await agents.update(agent._id, { claim: { tokenHash: hashToken(token), expiresAt } });
    return reply.code(201).send({ claim: { token, url: `${deps.publicUrl}/claim/${token}`, expiresAt: expiresAt.toISOString() } });
  });

  app.post("/v1/agents/me/keys", { preHandler: verifyAgentRequest(deps.db) }, async (req, reply) => {
    const body = parseOrError(AddKeyBody, req.body, reply);
    if (!body) return;
    const agent = req.agent!.doc;

    if (agent.keys.some((k) => k.publicKey === body.publicKey)) {
      return sendError(reply, 409, "key_in_use", "This public key is already registered");
    }

    const digest = sha256(canonicalizeToBytes({ agentId: agent._id, publicKey: body.publicKey, createdAt: body.createdAt }));
    const verified = verifySignature(
      { alg: "Ed25519", kid: "new", publicKey: base64UrlDecode(body.publicKey) },
      "key",
      digest,
      { alg: "Ed25519", kid: "new", sig: body.proof.sig },
    );
    if (!verified) return sendError(reply, 422, "invalid_signature", "Key proof does not verify against the new public key");

    const kid = newId("key");
    const newKey = { kid, alg: "Ed25519" as const, publicKey: body.publicKey, createdAt: new Date(body.createdAt), revokedAt: null };
    await agents.update(agent._id, { keys: [...agent.keys, newKey] });
    return reply.code(201).send({ key: keyView(newKey) });
  });

  app.delete<{ Params: { kid: string } }>(
    "/v1/agents/me/keys/:kid",
    { preHandler: verifyAgentRequest(deps.db) },
    async (req, reply) => {
      const agent = req.agent!.doc;
      const key = agent.keys.find((k) => k.kid === req.params.kid);
      if (!key) return sendError(reply, 404, "not_found", "Key not found");
      if (key.revokedAt) return reply.send({ key: keyView(key) });

      const activeKeys = agent.keys.filter((k) => !k.revokedAt);
      if (activeKeys.length === 1) return sendError(reply, 409, "last_key", "Cannot revoke the agent's only active key");

      const pinning = await sessions.findActiveOrPendingByAgent(agent._id);
      const pinned = pinning.some(
        (s) =>
          (s.initiator.agentId === agent._id && s.initiator.kid === key.kid) ||
          (s.counterparty.agentId === agent._id && s.counterparty.kid === key.kid),
      );
      if (pinned) return sendError(reply, 409, "key_pinned", "This key is pinned by an active session; suspend the agent instead");

      const revokedAt = new Date();
      const updatedKeys = agent.keys.map((k) => (k.kid === key.kid ? { ...k, revokedAt } : k));
      await agents.update(agent._id, { keys: updatedKeys });
      return reply.send({ key: keyView({ ...key, revokedAt }) });
    },
  );

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (req, reply) => {
    const agent = await agents.findById(req.params.agentId);
    if (!agent) return sendError(reply, 404, "not_found", "Agent not found");
    return { agent: agentPublicView(agent) };
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId/agent.json", async (req, reply) => {
    const agent = await agents.findById(req.params.agentId);
    if (!agent) return sendError(reply, 404, "not_found", "Agent not found");
    return agentCardFor(agent, deps);
  });
}
