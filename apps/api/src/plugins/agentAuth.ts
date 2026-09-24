import {
  agentsRepository,
  base64UrlDecode,
  canonicalizeToBytes,
  hex,
  requestNoncesRepository,
  sha256,
  verifySignature,
  type AgentDoc,
} from "@openglass/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import { sendError } from "../errors.js";

const CLOCK_SKEW_MS = 300_000;
const NONCE_TTL_MS = 10 * 60 * 1000;

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `verifyAgentRequest()` once the signed request is verified. */
    agent?: { doc: AgentDoc; kid: string };
    /** Set instead of `agent` for the self-signed `POST /v1/agents` registration path. */
    registeringKey?: { publicKey: Uint8Array };
  }
}

function headerString(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * SPEC §4.1: verifies the `OG-*` signed-request headers on `req`. In self-signed mode
 * (agent registration) the verifying key is `req.body.publicKey`, since the agent proves
 * it holds the key it's registering. Otherwise the key comes from the `OG-Agent`/`OG-Key`
 * agent record, and the agent must not be suspended.
 */
export function verifyAgentRequest(db: Db, opts: { selfSigned?: boolean } = {}) {
  const agents = agentsRepository(db);
  const nonces = requestNoncesRepository(db);

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const agentId = headerString(req, "og-agent");
    const kid = headerString(req, "og-key");
    const timestamp = headerString(req, "og-timestamp");
    const nonce = headerString(req, "og-nonce");
    const signature = headerString(req, "og-signature");

    if (!kid || !timestamp || !nonce || !signature || (!opts.selfSigned && !agentId)) {
      return sendError(reply, 401, "unauthenticated", "Missing signed-request headers");
    }

    const skewMs = Math.abs(Date.now() - Date.parse(timestamp));
    if (!Number.isFinite(skewMs) || skewMs > CLOCK_SKEW_MS) {
      return sendError(reply, 401, "clock_skew", "OG-Timestamp is outside the allowed ±300s window");
    }

    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const bodySha256 = hex(sha256(rawBody));
    const digest = sha256(canonicalizeToBytes({ method: req.method, path: req.url, timestamp, nonce, bodySha256 }));

    let publicKey: Uint8Array;
    let agentDoc: AgentDoc | null = null;

    if (opts.selfSigned) {
      if (kid !== "new") return sendError(reply, 401, "unauthenticated", 'OG-Key must be "new" when registering');
      const body = req.body as { publicKey?: string } | undefined;
      if (!body?.publicKey) return sendError(reply, 400, "validation_failed", "publicKey is required");
      try {
        publicKey = base64UrlDecode(body.publicKey);
      } catch {
        return sendError(reply, 400, "validation_failed", "publicKey is not valid base64url");
      }
    } else {
      agentDoc = await agents.findById(agentId!);
      if (!agentDoc) return sendError(reply, 401, "unauthenticated", "Unknown agent");
      const key = agentDoc.keys.find((k) => k.kid === kid);
      if (!key || key.revokedAt) return sendError(reply, 401, "unauthenticated", "Unknown or revoked key");
      publicKey = base64UrlDecode(key.publicKey);
    }

    const verified = verifySignature({ alg: "Ed25519", kid, publicKey }, "request", digest, {
      alg: "Ed25519",
      kid,
      sig: signature,
    });
    if (!verified) return sendError(reply, 401, "invalid_request_signature", "Request signature verification failed");

    const claimed = await nonces.claim(agentId ?? kid, nonce, new Date(Date.now() + NONCE_TTL_MS));
    if (!claimed) return sendError(reply, 401, "nonce_reused", "This nonce has already been used");

    if (agentDoc) {
      if (agentDoc.status === "suspended") return sendError(reply, 403, "agent_suspended", "Agent is suspended");
      req.agent = { doc: agentDoc, kid };
    } else {
      req.registeringKey = { publicKey };
    }
  };
}
