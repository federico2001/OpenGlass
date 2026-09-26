import { z } from "zod";

/**
 * All configuration comes from env vars. Behaviour is selected by explicit
 * values (SIGNER, EMAIL, …), never by which environment we're running in.
 */
const Env = z
  .object({
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    PUBLIC_URL: z.url(),
    MONGODB_URI: z.string().min(1),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    SIGNER: z.enum(["local", "kms"]),
    KMS_KEY_ID: z.string().optional(),
    /** PEM (PKCS8) ECDSA P-256 private key, required when SIGNER=local. Generate one with:
     *  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 */
    PLATFORM_SIGNER_LOCAL_KEY: z.string().optional(),
    PLATFORM_KID: z.string().min(1).default("plat_local"),
    /** RFC 3339 UTC, millisecond precision. The platform key's actual creation date — set
     * this whenever you provision or rotate PLATFORM_SIGNER_LOCAL_KEY/KMS_KEY_ID. Falls
     * back to the project genesis date, which is always safely before any record this key
     * could have signed (see apps/api/src/domain/platformKeys.ts). */
    PLATFORM_KEY_VALID_FROM: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      .optional(),
    EMAIL: z.enum(["smtp", "ses"]),
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z.string().min(1),
    /** Owner requests must send a matching Origin (SPEC §4.2); the web app's own origin. */
    WEB_ORIGIN: z.url(),
    /** Referenced (not called) from /.well-known/agent.json — apps/api never talks to mcp. */
    PUBLIC_MCP_URL: z.url().default("https://mcp.localhost"),
    /** x402 premium tier (Prompt 12). `/v1/premium/*` is registered only when this is set —
     * an EVM address (0x…) that receives payments. Unset in any environment that hasn't
     * been given a payout wallet, so the free-tier API is unaffected either way. */
    X402_PAY_TO_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
    /** Used only as a fallback when CDP credentials aren't set (e.g. local dev against
     * the free public facilitator, which is testnet-only — see CDP_API_KEY_ID below). */
    X402_FACILITATOR_URL: z.url().default("https://x402.org/facilitator"),
    /** CAIP-2 chain id. Base Sepolia (testnet) by default — swap to eip155:8453 for Base mainnet. */
    X402_NETWORK: z.string().regex(/^[a-z0-9-]+:.+$/).default("eip155:84532"),
    /** Coinbase Developer Platform facilitator credentials (SPEC-adjacent, Prompt 12).
     * Required for Base mainnet — the free public facilitator only settles testnet. When
     * both are set, the CDP facilitator replaces X402_FACILITATOR_URL entirely. */
    CDP_API_KEY_ID: z.string().optional(),
    CDP_API_KEY_SECRET: z.string().optional(),
    /** The records bucket's own Object Lock default mode (must match what infra actually
     * deployed — see infra/lib/openglass-stack.ts). Only used as a fallback in the premium
     * extend-retention route. */
    OBJECT_LOCK_MODE: z.enum(["GOVERNANCE", "COMPLIANCE"]).default("COMPLIANCE"),
    /** Comma-separated owner emails allowed to use /v1/admin/* (Prompt 23's integration
     * request-board status management). Empty by default — nobody is an admin until this
     * is set. Lowercased/trimmed at parse time to match Owner.email's stored form. */
    ADMIN_EMAILS: z
      .string()
      .default("")
      .transform((v) => v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
  })
  .superRefine((env, ctx) => {
    if (env.SIGNER === "kms" && !env.KMS_KEY_ID) ctx.addIssue({ code: "custom", path: ["KMS_KEY_ID"], message: "required when SIGNER=kms" });
    if (env.SIGNER === "local" && !env.PLATFORM_SIGNER_LOCAL_KEY) {
      ctx.addIssue({ code: "custom", path: ["PLATFORM_SIGNER_LOCAL_KEY"], message: "required when SIGNER=local" });
    }
    if (env.EMAIL === "smtp" && !env.SMTP_URL) ctx.addIssue({ code: "custom", path: ["SMTP_URL"], message: "required when EMAIL=smtp" });
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
