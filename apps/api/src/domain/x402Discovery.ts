import type { RoutesConfig } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { X402Deps } from "./x402.js";

/**
 * x402 Bazaar discovery metadata for the three paid `/v1/premium/*` routes
 * (https://docs.x402.org/extensions/bazaar). Each route declares the `bazaar` extension so
 * it rides along in the 402 `PAYMENT-REQUIRED` header; a facilitator catalogs the route
 * only once a paying client echoes that extension back at settlement. The
 * `bazaarResourceServerExtension` registered in domain/x402.ts fills in the concrete HTTP
 * method (so the declarations below leave it out) and, for the `:recordId` routes, the `routeTemplate` that collapses every record
 * into one catalog entry.
 *
 * Payment and auth are separate: x402 pays for the call, and the call itself must still
 * carry the caller's own signed `OG-*` headers (SPEC §4.1), checked after payment by the
 * route's normal preHandler. Nothing here changes `accepts`, prices, network or payTo.
 */

/** Service metadata shared by all three routes (catalog display only). */
function serviceMetadata(webOrigin: string) {
  return {
    serviceName: "OpenGlass",
    tags: ["agents", "verification", "records", "a2a"],
    iconUrl: `${webOrigin}/icon.svg`,
  };
}

const SIGNED_REQUEST_NOTE =
  "The request must also carry the caller's signed OG-* headers (Ed25519, OpenGlass SPEC §4.1). " +
  "That signature identifies the agent and is separate from the x402 payment.";

const recordIdPathParamsSchema = {
  properties: {
    recordId: {
      type: "string",
      description: "Id of a witnessed session record (rec_...) the caller's agent or owner can read.",
    },
  },
  required: ["recordId"],
};

const recordIdExample = { recordId: "rec_01JNk3tvhVmwN55JM1DBiHkLAB" };

const verifiedBadgeExtension = declareDiscoveryExtension({
  bodyType: "json",
  input: {},
  inputSchema: {
    type: "object",
    description: `No body or parameters: the signed request identifies the agent. ${SIGNED_REQUEST_NOTE} The agent must be claimed by an owner.`,
    properties: {},
  },
  output: {
    example: {
      agent: { id: "agt_01JNk3tvhVmwN55JM1DBiHkLCD", name: "Example agent", claimed: true, verifiedBadge: true },
    },
    schema: {
      properties: {
        agent: {
          type: "object",
          description: "The caller's own agent profile after the badge is set.",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            claimed: { type: "boolean" },
            verifiedBadge: { type: "boolean" },
          },
          required: ["id", "verifiedBadge"],
        },
      },
      required: ["agent"],
    },
  },
});

const extendRetentionExtension = declareDiscoveryExtension({
  bodyType: "json",
  input: {},
  inputSchema: {
    type: "object",
    description: `No body. ${SIGNED_REQUEST_NOTE} A signed-in owner session also works.`,
    properties: {},
  },
  pathParams: recordIdExample,
  pathParamsSchema: recordIdPathParamsSchema,
  output: {
    example: { recordId: "rec_01JNk3tvhVmwN55JM1DBiHkLAB", retentionMode: "COMPLIANCE", retainUntilDate: "2036-11-13T00:00:00.000Z" },
    schema: {
      properties: {
        recordId: { type: "string" },
        retentionMode: { type: "string", description: "S3 Object Lock mode already on the record's evidence (never changed)." },
        retainUntilDate: { type: "string", description: "New retain-until date (RFC 3339), 10 years from the call." },
      },
      required: ["recordId", "retentionMode", "retainUntilDate"],
    },
  },
});

const recordPdfExtension = declareDiscoveryExtension({
  input: {},
  inputSchema: {
    type: "object",
    description: `No query parameters. ${SIGNED_REQUEST_NOTE} A signed-in owner session also works.`,
    properties: {},
  },
  pathParams: recordIdExample,
  pathParamsSchema: recordIdPathParamsSchema,
  output: {
    // The response is the PDF bytes themselves (content-type: application/pdf), not JSON.
    example: "<application/pdf bytes>",
    schema: { properties: {}, description: "application/pdf document summarizing the record." },
  },
});

/** The x402 `RoutesConfig` for `paymentMiddleware` in server.ts. */
export function premiumRoutesConfig(x402: Pick<X402Deps, "payTo" | "network">, webOrigin: string): RoutesConfig {
  const { payTo, network } = x402;
  const meta = serviceMetadata(webOrigin);
  return {
    "POST /v1/premium/agents/me/verified-badge": {
      accepts: { scheme: "exact", network, payTo, price: "$1.00" },
      description: "Mark this agent as verified — shown on its public profile and in agent.json.",
      ...meta,
      extensions: { ...verifiedBadgeExtension },
    },
    "POST /v1/premium/records/:recordId/extend-retention": {
      accepts: { scheme: "exact", network, payTo, price: "$0.50" },
      description: "Extend a record's evidence retention (S3 Object Lock) by 10 years.",
      ...meta,
      extensions: { ...extendRetentionExtension },
    },
    "GET /v1/premium/records/:recordId/pdf": {
      accepts: { scheme: "exact", network, payTo, price: "$0.25" },
      description: "A human-readable PDF summary of a witnessed session record.",
      mimeType: "application/pdf",
      ...meta,
      extensions: { ...recordPdfExtension },
    },
  };
}
