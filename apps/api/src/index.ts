import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { connectFromEnv, createPlatformSigner, migrate } from "@openglass/db";
import { loadConfig } from "./config.js";
import { checkDomainVerification } from "./domain/domainVerification.js";
import { createX402Deps } from "./domain/x402.js";
import { createMailer } from "./mailer.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const conn = await connectFromEnv("openglass-api");

// Validators, indexes and data migrations are applied on every start (idempotent, locked).
const report = await migrate(conn.db, conn.client, { log: (m) => console.log(`[migrate] ${m}`) });
console.log(`[migrate] done: ${JSON.stringify(report)}`);

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});

const signer = createPlatformSigner({
  signer: config.SIGNER,
  kid: config.PLATFORM_KID,
  localPrivateKeyPem: config.PLATFORM_SIGNER_LOCAL_KEY,
  kmsKeyId: config.KMS_KEY_ID,
  awsRegion: config.S3_REGION,
});
const mailer = createMailer(config, config.S3_REGION);
const x402 = await createX402Deps(config);
if (x402) console.log(`[x402] premium tier enabled: network=${x402.network} payTo=${x402.payTo}`);

const app = buildServer({
  logger: { level: config.LOG_LEVEL },
  healthChecks: {
    mongo: () => conn.db.command({ ping: 1 }),
    s3: () => s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })),
  },
  db: conn.db,
  mongoClient: conn.client,
  signer,
  platformKeyValidFrom: config.PLATFORM_KEY_VALID_FROM,
  mailer,
  publicUrl: config.PUBLIC_URL,
  webOrigin: config.WEB_ORIGIN,
  publicMcpUrl: config.PUBLIC_MCP_URL,
  s3,
  s3Bucket: config.S3_BUCKET,
  objectLockMode: config.OBJECT_LOCK_MODE,
  x402,
  checkDomainVerification,
  adminEmails: config.ADMIN_EMAILS,
});

await app.listen({ host: "0.0.0.0", port: config.PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await conn.close();
    process.exit(0);
  });
}
