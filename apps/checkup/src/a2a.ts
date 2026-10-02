import { z } from "zod";

/**
 * A2A agent cards, as the current spec (1.0) and the previous one (0.3) define them.
 * Field requirements follow the A2A 1.0 proto's REQUIRED field behaviors (`a2a.proto`,
 * mirrored by @a2a-js/sdk 1.x) and the 0.3 JSON schema. Unknown fields are allowed: both
 * specs let cards carry extensions, and many cards carry both versions' fields at once.
 */

export const A2A_CURRENT = "1.0";
export const A2A_LEGACY = "0.3";

const nonEmpty = z.string().trim().min(1);

const Provider = z.object({ organization: nonEmpty, url: z.url() });

const Skill = z.object({
  id: nonEmpty,
  name: nonEmpty,
  description: nonEmpty,
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

const Interface = z.object({ url: z.url(), protocolBinding: nonEmpty, protocolVersion: nonEmpty, tenant: z.string().optional() });

const Capabilities = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extensions: z.array(z.object({ uri: nonEmpty, description: z.string().optional(), required: z.boolean().optional() })).optional(),
});

export const AgentCardV1 = z.object({
  name: nonEmpty,
  description: nonEmpty,
  supportedInterfaces: z.array(Interface).min(1),
  provider: Provider.optional(),
  version: nonEmpty,
  documentationUrl: z.url().optional(),
  capabilities: Capabilities,
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(Skill),
  iconUrl: z.url().optional(),
});

export const AgentCardV03 = z.object({
  protocolVersion: nonEmpty,
  name: nonEmpty,
  description: nonEmpty,
  url: z.url(),
  preferredTransport: z.string().optional(),
  provider: Provider.optional(),
  version: nonEmpty,
  documentationUrl: z.url().optional(),
  capabilities: Capabilities,
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(Skill),
  iconUrl: z.url().optional(),
});

export type CardShape = "1.0" | "0.3";

/** Which spec a card was written against: 1.0 cards list `supportedInterfaces`; 0.3 cards
 * have a top-level `url`. Same rule the official SDK's card resolver uses. */
export function cardShape(card: Record<string, unknown>): CardShape {
  if (Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0) return "1.0";
  if (typeof card.url === "string" || typeof card.protocolVersion === "string") return "0.3";
  return "1.0";
}

export interface Endpoint {
  url: string;
  binding: "JSONRPC" | "HTTP+JSON" | "GRPC" | string;
  protocolVersion: string;
}

/** The interfaces a card advertises, preferred first. */
export function endpointsOf(card: Record<string, unknown>): Endpoint[] {
  if (cardShape(card) === "1.0") {
    return (card.supportedInterfaces as unknown[])
      .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
      .filter((i) => typeof i.url === "string")
      .map((i) => ({
        url: i.url as string,
        binding: typeof i.protocolBinding === "string" ? i.protocolBinding.toUpperCase() : "JSONRPC",
        protocolVersion: typeof i.protocolVersion === "string" ? i.protocolVersion : A2A_CURRENT,
      }));
  }
  const out: Endpoint[] = [];
  const version = typeof card.protocolVersion === "string" ? card.protocolVersion : A2A_LEGACY;
  if (typeof card.url === "string") {
    out.push({ url: card.url, binding: typeof card.preferredTransport === "string" ? card.preferredTransport.toUpperCase() : "JSONRPC", protocolVersion: version });
  }
  if (Array.isArray(card.additionalInterfaces)) {
    for (const i of card.additionalInterfaces as Record<string, unknown>[]) {
      if (i && typeof i.url === "string") out.push({ url: i.url, binding: String(i.transport ?? "JSONRPC").toUpperCase(), protocolVersion: version });
    }
  }
  return out;
}

/** True when the card says it takes x402 payments anywhere a client would look: a declared
 * extension, a security scheme, or a skill tag. */
export function claimsX402(card: Record<string, unknown>): boolean {
  const caps = card.capabilities as { extensions?: { uri?: unknown }[] } | undefined;
  if (caps?.extensions?.some((e) => typeof e?.uri === "string" && /x402/i.test(e.uri))) return true;
  if (card.securitySchemes && /x402/i.test(JSON.stringify(Object.keys(card.securitySchemes as object)))) return true;
  const skills = Array.isArray(card.skills) ? (card.skills as { tags?: unknown }[]) : [];
  return skills.some((s) => Array.isArray(s?.tags) && s.tags.some((t) => typeof t === "string" && /x402/i.test(t)));
}

// ---------------------------------------------------------------- this agent's own card

export const CHECK_SKILL_ID = "check-agent";

export function ownAgentCard(publicUrl: string, openglassUrl: string) {
  const endpoint = `${publicUrl}/a2a`;
  return {
    name: "Agent Checkup by OpenGlass",
    description:
      "Checks an A2A agent from the outside and tells you what to fix. Give it an agent-card URL or a domain. " +
      "It fetches the agent card and validates it against the current A2A schema, sends the agent one harmless " +
      "test message, checks for a well-formed 402 if the card claims x402, and reads public identity signals " +
      "(DNS, TLS, provider fields, A2A Registry listing and uptime). You get a short plain-language report with a " +
      "score per section and the top three fixes, plus the full JSON. Each checkup is recorded on OpenGlass, a " +
      "neutral witness for agent-to-agent interactions, and the report links to that record so anyone can verify " +
      "it offline. The agent being checked needs nothing from OpenGlass.",
    version: "1.0.0",
    supportedInterfaces: [
      { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: A2A_CURRENT },
      { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: A2A_LEGACY },
    ],
    // A2A 0.3 fields, for clients that predate supportedInterfaces. A 1.0 client ignores them.
    protocolVersion: A2A_LEGACY,
    url: endpoint,
    preferredTransport: "JSONRPC",
    provider: { organization: "OpenGlass", url: openglassUrl },
    documentationUrl: `${publicUrl}/`,
    iconUrl: `${openglassUrl}/icon.svg`,
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: CHECK_SKILL_ID,
        name: "Check an agent",
        description:
          "Runs a checkup on one A2A agent. Input: an agent-card URL " +
          "(https://example.com/.well-known/agent-card.json) or a bare domain (example.com), as text, or as a JSON " +
          'data part {"target": "..."}. Output: a text report and the same report as JSON. Results are cached for an hour.',
        tags: ["a2a", "agent-card", "validation", "x402", "health-check", "identity"],
        examples: [
          "Check https://example.com/.well-known/agent-card.json",
          "example.com",
          "Run a checkup on agents.example.org",
        ],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain", "application/json"],
      },
    ],
  };
}
