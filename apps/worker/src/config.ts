import { z } from "zod";

/** Same shape as apps/api/src/config.ts — the worker needs the same DB/S3/signer/email
 * wiring, plus its own poll interval. All config comes from env vars (CLAUDE.md). */
const Env = z
  .object({
    PORT: z.coerce.number().int().default(3003),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    PUBLIC_URL: z.url(),
    MONGODB_URI: z.string().min(1),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    SIGNER: z.enum(["local", "kms"]),
    KMS_KEY_ID: z.string().optional(),
    PLATFORM_SIGNER_LOCAL_KEY: z.string().optional(),
    PLATFORM_KID: z.string().min(1).default("plat_local"),
    /** Same var and meaning as apps/api/src/config.ts — must match across both. */
    PLATFORM_KEY_VALID_FROM: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      .optional(),
    EMAIL: z.enum(["smtp", "ses"]),
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z.string().min(1),
    /** How often the poll loop sweeps for expired/closing sessions. */
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
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
