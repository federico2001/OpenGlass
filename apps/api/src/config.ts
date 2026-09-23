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
    EMAIL: z.enum(["smtp", "ses"]),
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z.string().min(1),
    /** Owner requests must send a matching Origin (SPEC §4.2); the web app's own origin. */
    WEB_ORIGIN: z.url(),
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
