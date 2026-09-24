import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import type { Config } from "../config.js";

/**
 * x402 premium tier (Prompt 12). Additive on top of the free v1 API — `docs/openapi.yaml`
 * stays an accurate free-tier contract, so this lives entirely outside it (SPEC/plan
 * decision, not an oversight).
 *
 * `null` when `X402_PAY_TO_ADDRESS` isn't configured, in which case `/v1/premium/*` is
 * never registered and the rest of the API is completely unaffected — this is meant to be
 * safe to leave off in any environment that hasn't been handed a real payout wallet.
 */
/** CAIP-2 network id, e.g. "eip155:84532". */
type NetworkId = `${string}:${string}`;

export interface X402Deps {
  resourceServer: x402ResourceServer;
  payTo: string;
  network: NetworkId;
}

export async function createX402Deps(config: Config): Promise<X402Deps | null> {
  if (!config.X402_PAY_TO_ADDRESS) return null;

  // The config schema enforces the CAIP-2 `namespace:reference` shape at parse time (see
  // config.ts), but Zod can't carry a regex constraint into the type system as a
  // template-literal type, hence the one cast here rather than one at every call site.
  const network = config.X402_NETWORK as NetworkId;
  // CDP's facilitator settles Base mainnet (required for real payments); the free public
  // one at X402_FACILITATOR_URL only settles testnet, so it's a dev-only fallback.
  const facilitatorClient =
    config.CDP_API_KEY_ID && config.CDP_API_KEY_SECRET
      ? createCdpFacilitatorClient({ apiKeyId: config.CDP_API_KEY_ID, apiKeySecret: config.CDP_API_KEY_SECRET })
      : new HTTPFacilitatorClient({ url: config.X402_FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(network, new ExactEvmScheme());
  // Fetches the facilitator's supported (scheme, network) kinds once at boot so route
  // validation below can catch a misconfigured network immediately, not on first request.
  await resourceServer.initialize();

  return { resourceServer, payTo: config.X402_PAY_TO_ADDRESS, network };
}
