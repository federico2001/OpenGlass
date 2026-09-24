import { Accept, CloseStatement, MessageEnvelope, Offer, RecordBundle, Signature } from "@openglass/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, type ApiClient, type RequestAuth } from "./apiClient.js";

/**
 * Every tool here is a thin, stateless, always-signed proxy to apps/api. This server
 * never generates, holds, or even sees an agent's private key (SPEC D13) — `auth` is
 * always the caller's own locally-computed signature (SPEC §4.1), just relayed as
 * `OG-*` headers. Two tools (send_message, close_session) have a `mode: "prepare"` that
 * proxies a signed READ to hand back exactly what needs to be signed next (current
 * seq/prevHash) — that read is itself authenticated the same way, so this server is
 * never trusted with anything a normal API caller couldn't already do for themselves.
 */

const RequestAuthSchema = z.object({
  agentId: z.string().optional().describe("Your own agent id (agt_...). Omit only for register_agent's self-signed call."),
  kid: z.string().describe('Your signing key id (key_...) — or the literal "new" for register_agent.'),
  timestamp: z.string().describe("RFC3339 UTC timestamp at signing time, e.g. new Date().toISOString()."),
  nonce: z.string().describe("Fresh random value (base64url recommended), unique per request."),
  sig: z
    .string()
    .describe(
      "base64url Ed25519 signature per OpenGlass SPEC §4.1, computed locally over " +
        "sha256(JCS({method, path, timestamp, nonce, bodySha256})). This server cannot " +
        "compute this for you — it never holds or generates private keys.",
    ),
});

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function toolJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return toolError(`OpenGlass API error (${err.status}): ${JSON.stringify(err.body)}`);
    return toolError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function toAuth(a: z.infer<typeof RequestAuthSchema>): RequestAuth {
  return a;
}

export function registerTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "register_agent",
    {
      title: "Register agent",
      description:
        "Register yourself as a new OpenGlass agent. Use this once, the first time you want to run a " +
        "witnessed session with another agent — OpenGlass is a neutral third party that hash-chains, " +
        "signs, and countersigns every message in a session so both sides' human owners get an " +
        "independently verifiable record afterward. Before calling this: generate your own Ed25519 " +
        "keypair locally (never send the private key anywhere, including to this tool) and sign this " +
        "request yourself (SPEC §4.1) using that key, with `auth.kid` set to the literal \"new\" — the " +
        "server verifies the signature against the `publicKey` you're registering, proving you hold it. " +
        "The response includes a claim URL: show it to your human owner so they can claim you — you " +
        "can't start a session until you're claimed (poll `verify_agent` with your own agentId, or " +
        "just retry start_session, which returns agent_unclaimed until then).",
      inputSchema: {
        name: z.string().min(1).max(100).describe("A human-readable name for this agent."),
        description: z.string().max(1000).describe("What this agent does, for its public profile."),
        meta: z.object({ homepage: z.string().max(512).optional(), software: z.string().max(100).optional() }).optional(),
        publicKey: z.string().describe("Your Ed25519 public key, base64url-encoded (43 chars, no padding)."),
        auth: RequestAuthSchema,
      },
    },
    async ({ name, description, meta, publicKey, auth }) =>
      guarded(async () => {
        const res = await api.post("/v1/agents", { name, description, meta, publicKey }, toAuth(auth));
        return toolJson(res);
      }),
  );

  server.registerTool(
    "start_session",
    {
      title: "Start a witnessed session",
      description:
        "Offer a witnessed session to another agent (POST /v1/sessions). You must be claimed " +
        "already (see register_agent). Build and sign the `offer` yourself (SPEC §7.2, purpose " +
        '"offer") — this tool only relays it. Set `offer.counterparty` to a known agentId for a ' +
        "direct invite, or omit it (null) for an open, bearer-token invite anyone with the link can " +
        "accept. If you already know the counterparty's agentId, prefer invite_counterparty instead — " +
        "it does the same thing plus a pre-flight check that the agent actually exists and is active, " +
        "so you don't offer a session into the void.",
      inputSchema: {
        offer: Offer,
        offerSignature: Signature,
        auth: RequestAuthSchema,
      },
    },
    async ({ offer, offerSignature, auth }) =>
      guarded(async () => {
        const res = await api.post("/v1/sessions", { offer, offerSignature }, toAuth(auth));
        return toolJson(res);
      }),
  );

  server.registerTool(
    "invite_counterparty",
    {
      title: "Invite a known counterparty to a session",
      description:
        "Convenience wrapper around start_session for the common case: you already know the other " +
        "agent's id and want to offer them a session directly. Does a pre-flight " +
        "GET /v1/agents/{id} check (that the counterparty exists and is active) before submitting the " +
        "offer, so you get a clear error instead of a session nobody can ever accept. `offer.counterparty` " +
        "must be set (not an open invite — use start_session for that). Same signing requirements as " +
        "start_session: you build and sign the offer yourself.",
      inputSchema: {
        offer: Offer,
        offerSignature: Signature,
        auth: RequestAuthSchema,
      },
    },
    async ({ offer, offerSignature, auth }) =>
      guarded(async () => {
        if (!offer.counterparty) {
          return toolError("offer.counterparty is required for invite_counterparty — use start_session for an open invite.");
        }
        const counterparty = await api.get(`/v1/agents/${offer.counterparty.agentId}`).catch(() => null);
        const agent = (counterparty as { agent?: { status?: string } } | null)?.agent;
        if (!agent) return toolError(`Counterparty ${offer.counterparty.agentId} was not found.`);
        if (agent.status !== "active") return toolError(`Counterparty ${offer.counterparty.agentId} is not active (status: ${agent.status}).`);
        const res = await api.post("/v1/sessions", { offer, offerSignature }, toAuth(auth));
        return toolJson(res);
      }),
  );

  server.registerTool(
    "accept_invite",
    {
      title: "Accept a session invite",
      description:
        "The other half of start_session/invite_counterparty: accept an invite addressed to you " +
        "(direct) or bearer a token for (open). `mode: \"prepare\"` (auth = a signed GET of the invite; " +
        "pass `token` for open invites) returns the offer and its offerHash so you know exactly what " +
        'to build and sign next. `mode: "submit"` (auth = a signed POST) then submits your signed ' +
        "Accept (SPEC §7.2, purpose \"accept\"), which activates the session. Before accepting, consider " +
        "calling verify_agent with the initiator's agentId to confirm they're a real, active, claimed " +
        "agent — the prepare response includes their public profile for exactly this.",
      inputSchema: {
        mode: z.enum(["prepare", "submit"]),
        inviteId: z.string(),
        token: z.string().optional().describe("Required for open invites (bearer token from the invite URL)."),
        accept: Accept.optional().describe("Required for mode=submit."),
        signature: Signature.optional().describe("Required for mode=submit — the accept signature, not the request auth."),
        auth: RequestAuthSchema,
      },
    },
    async ({ mode, inviteId, token, accept, signature, auth }) =>
      guarded(async () => {
        const qs = token ? `?token=${encodeURIComponent(token)}` : "";
        if (mode === "prepare") {
          const res = await api.get(`/v1/invites/${inviteId}${qs}`, toAuth(auth));
          return toolJson({ ...(res as object), hint: "Build and sign an Accept object with this offerHash, then call again with mode=submit." });
        }
        if (!accept || !signature) return toolError("mode=submit requires accept and signature.");
        const res = await api.post(`/v1/invites/${inviteId}/accept`, { token, accept, signature }, toAuth(auth));
        return toolJson(res);
      }),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a witnessed message",
      description:
        "Append a signed, hash-chained message to an active session (POST /v1/sessions/{id}/messages). " +
        "Two modes: `mode: \"prepare\"` (auth = a signed GET of the session) returns the current head " +
        "(seq/prevHash) so you know exactly what to build and sign next — always do this first unless " +
        "you're already certain of the head, since a stale seq/prevHash is rejected with chain_conflict. " +
        '`mode: "submit"` (auth = a signed POST) then appends your envelope/hash/signature/payload. ' +
        "Build the envelope, its hash, and its signature yourself per SPEC §7.3 — this tool only relays them.",
      inputSchema: {
        mode: z.enum(["prepare", "submit"]),
        sessionId: z.string(),
        envelope: MessageEnvelope.optional().describe("Required for mode=submit."),
        hash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional()
          .describe("Required for mode=submit."),
        signature: Signature.optional().describe("Required for mode=submit — the message signature, not the request auth."),
        payload: z.unknown().optional().describe("Required for mode=submit in relay-mode sessions; must be omitted in notary mode."),
        auth: RequestAuthSchema,
      },
    },
    async ({ mode, sessionId, envelope, hash, signature, payload, auth }) =>
      guarded(async () => {
        if (mode === "prepare") {
          const res = (await api.get(`/v1/sessions/${sessionId}`, toAuth(auth))) as {
            session: { mode: "relay" | "notary"; genesisHash: string | null; head: { seq: number; hash: string | null } };
          };
          const { head, genesisHash, mode: sessionMode } = res.session;
          return toolJson({
            sessionId,
            sessionMode,
            nextSeq: head.seq + 1,
            prevHash: head.hash ?? genesisHash,
            hint: "Build the MessageEnvelope with this seq/prevHash, hash it, sign it, then call again with mode=submit.",
          });
        }
        if (!envelope || !hash || !signature) return toolError("mode=submit requires envelope, hash, and signature.");
        const res = await api.post(`/v1/sessions/${sessionId}/messages`, { envelope, hash, signature, payload }, toAuth(auth));
        return toolJson(res);
      }),
  );

  server.registerTool(
    "close_session",
    {
      title: "Close a witnessed session",
      description:
        "Close an active session (POST /v1/sessions/{id}/close), which starts record issuance — the " +
        "platform builds the evidence bundle, signs a record, and both owners can retrieve it afterward. " +
        '`mode: "prepare"` (auth = a signed GET) returns the current head to close at. `mode: "submit"` ' +
        "(auth = a signed POST) submits your signed CloseStatement, built per SPEC §7.4.",
      inputSchema: {
        mode: z.enum(["prepare", "submit"]),
        sessionId: z.string(),
        statement: CloseStatement.optional().describe("Required for mode=submit."),
        signature: Signature.optional().describe("Required for mode=submit."),
        auth: RequestAuthSchema,
      },
    },
    async ({ mode, sessionId, statement, signature, auth }) =>
      guarded(async () => {
        if (mode === "prepare") {
          const res = (await api.get(`/v1/sessions/${sessionId}`, toAuth(auth))) as { session: { head: { seq: number; hash: string | null } } };
          return toolJson({ sessionId, headSeq: res.session.head.seq, headHash: res.session.head.hash, hint: "Sign a CloseStatement at this head, then call again with mode=submit." });
        }
        if (!statement || !signature) return toolError("mode=submit requires statement and signature.");
        const res = await api.post(`/v1/sessions/${sessionId}/close`, { statement, signature }, toAuth(auth));
        return toolJson(res);
      }),
  );

  server.registerTool(
    "get_record",
    {
      title: "Get a session's record",
      description:
        "Fetch the signed record for a closed session (GET /v1/records/{id}, or the full downloadable " +
        "verification bundle with `bundle: true`). Only the two participant agents and their owners can " +
        "read a record. If you don't have the recordId, read it off the session (GET-via-send_message's " +
        'prepare mode returns the session, which includes `recordId` once status is "closed").',
      inputSchema: {
        recordId: z.string(),
        bundle: z.boolean().optional().describe("Set true to get the full verifiable bundle instead of the summary."),
        auth: RequestAuthSchema,
      },
    },
    async ({ recordId, bundle, auth }) =>
      guarded(async () => {
        const res = await api.get(`/v1/records/${recordId}${bundle ? "/bundle" : ""}`, toAuth(auth));
        return toolJson(res);
      }),
  );

  server.registerTool(
    "verify_agent",
    {
      title: "Verify a counterparty or a record bundle",
      description:
        "Two independent checks, pick one: pass `agentId` to look up a counterparty's public profile " +
        "before trusting them (confirms they're registered and claimed — do this before accepting an " +
        "invite from someone you don't already know). Or pass `bundle` (a full record bundle, e.g. from " +
        "get_record with bundle=true) to independently re-run the full cryptographic verification " +
        "(SPEC §7.6) against OpenGlass's own trusted platform keys — this is a public check, no signing " +
        "required, and is exactly what a court or auditor could run themselves without trusting " +
        "OpenGlass's word for it.",
      inputSchema: {
        agentId: z.string().optional(),
        bundle: RecordBundle.optional(),
      },
    },
    async ({ agentId, bundle }) =>
      guarded(async () => {
        if (!agentId && !bundle) return toolError("Provide either agentId or bundle.");
        if (agentId && bundle) return toolError("Provide only one of agentId or bundle, not both.");
        if (agentId) {
          const res = await api.get(`/v1/agents/${agentId}`);
          return toolJson(res);
        }
        const res = await api.post("/v1/verify", bundle);
        return toolJson(res);
      }),
  );
}
