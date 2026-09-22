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
    EMAIL: z.enum(["smtp", "ses"]),
    SMTP_URL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.SIGNER === "kms" && !env.KMS_KEY_ID) ctx.addIssue({ code: "custom", path: ["KMS_KEY_ID"], message: "required when SIGNER=kms" });
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
