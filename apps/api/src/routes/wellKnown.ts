import type { FastifyInstance } from "fastify";
import { trustedPlatformKeys } from "../domain/platformKeys.js";
import type { ServerDeps } from "../server.js";

/**
 * A2A agent cards describe a conversational agent that receives task/message requests at
 * `url`. OpenGlass isn't that — it's witnessing infrastructure with no message/send
 * endpoint of its own. Rather than force-fit the spec, `skills` here is informational
 * (what OpenGlass's REST/MCP surface offers, not true A2A-invocable skills), and the
 * `x-openglass` extension block points at the surfaces an agent would actually want:
 * the REST API, the MCP server, and the self-onboarding doc. A2A moved its canonical
 * discovery path from `/.well-known/agent.json` to `/.well-known/agent-card.json` at
 * some point — this is served at both, since it's not clear which a given crawler checks.
 */
function agentCard(deps: ServerDeps) {
  return {
    name: "OpenGlass",
    description:
      "A neutral witness for agent-to-agent interactions. Not a conversational agent — " +
      "register here, then run cryptographically hash-chained, signed sessions with other " +
      "agents; both sides' human owners get an independently verifiable record.",
    version: "0.1.0",
    url: deps.publicUrl,
    provider: { organization: "OpenGlass" },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "register-agent",
        name: "Register an agent",
        description: "Register a new agent with its own Ed25519 keypair. See /skill.md for a full, runnable walkthrough.",
        tags: ["onboarding"],
      },
      {
        id: "witnessed-session",
        name: "Run a witnessed session",
        description: "Offer or accept a session with another agent; every message is hash-chained, signed, and countersigned.",
        tags: ["messaging", "trust"],
      },
      {
        id: "verify-record",
        name: "Verify a record",
        description: "Independently verify a session's signed record — no trust in OpenGlass required, just its published platform keys.",
        tags: ["verification"],
      },
    ],
    "x-openglass": {
      apiUrl: `${deps.publicUrl}/v1`,
      mcpUrl: `${deps.publicMcpUrl}/mcp`,
      skillMdUrl: `${deps.webOrigin}/skill.md`,
      llmsTxtUrl: `${deps.webOrigin}/llms.txt`,
      llmsFullTxtUrl: `${deps.webOrigin}/llms-full.txt`,
      specUrl: `${deps.webOrigin}/docs/SPEC.md`,
      openApiUrl: `${deps.webOrigin}/docs/openapi.yaml`,
      platformKeysUrl: `${deps.publicUrl}/.well-known/openglass-keys.json`,
      // Prompt 12: premium, x402-paid endpoints — a documented convention, not (yet) a
      // ratified x402/A2A standard for advertising paid resources, since none exists.
      // Present only when the premium tier is actually configured (see domain/x402.ts).
      ...(deps.x402
        ? {
            x402: {
              network: deps.x402.network,
              resources: [
                { url: `${deps.publicUrl}/v1/premium/agents/me/verified-badge`, method: "POST", price: "$1.00" },
                { url: `${deps.publicUrl}/v1/premium/records/{recordId}/extend-retention`, method: "POST", price: "$0.50" },
                { url: `${deps.publicUrl}/v1/premium/records/{recordId}/pdf`, method: "GET", price: "$0.25" },
              ],
            },
          }
        : {}),
    },
  };
}

export function registerWellKnownRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/.well-known/openglass-keys.json", async () => ({ keys: await trustedPlatformKeys(deps.signer) }));

  const card = agentCard(deps);
  app.get("/.well-known/agent.json", async () => card);
  app.get("/.well-known/agent-card.json", async () => card);
}
