import { z } from "zod";

const Base64Url32 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "must be a 32-byte Ed25519 private key, base64url without padding (43 characters)");

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().default(3004),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MONGODB_URI: z.string().min(1),
  /** This service's public origin, e.g. https://checkup.openglass.glass. */
  CHECKUP_PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  /** Where to reach the OpenGlass API (inside Docker: http://api:3000). */
  OPENGLASS_API_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  /** The public OpenGlass origin, for links people open. */
  OPENGLASS_PUBLIC_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  /** The checkup agent's Ed25519 private key. Generate once:
   * node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" */
  CHECKUP_AGENT_PRIVATE_KEY: Base64Url32,
  /** Password for /admin (HTTP Basic, any username). */
  CHECKUP_ADMIN_TOKEN: z.string().min(16),
  A2A_REGISTRY_URL: z.url().default("https://a2aregistry.org"),
  /** Test-only: lets the SSRF guard connect to loopback/private addresses (a local fake
   * target). Leave unset everywhere else. */
  CHECKUP_ALLOW_PRIVATE_TARGETS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}
