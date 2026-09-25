import { S3Client } from "@aws-sdk/client-s3";
import { connectFromEnv, createPlatformSigner } from "@openglass/db";
import { loadConfig } from "./config.js";
import { buildHealthServer } from "./health.js";
import { closeExpiredSessions } from "./jobs/closeExpiredSessions.js";
import { closeSuspendedAgentSessions } from "./jobs/closeSuspendedAgentSessions.js";
import { issueRecords } from "./jobs/issueRecords.js";
import { recordActivitySnapshot } from "./jobs/recordActivitySnapshot.js";
import { createMailer } from "./mailer.js";

// The api container owns migrations; the worker only connects.
const config = loadConfig();
const conn = await connectFromEnv("openglass-worker");

const s3 = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: config.S3_FORCE_PATH_STYLE });
const signer = createPlatformSigner({
  signer: config.SIGNER,
  kid: config.PLATFORM_KID,
  localPrivateKeyPem: config.PLATFORM_SIGNER_LOCAL_KEY,
  kmsKeyId: config.KMS_KEY_ID,
  awsRegion: config.S3_REGION,
});
const mailer = createMailer(config, config.S3_REGION);

const log = (message: string, meta?: Record<string, unknown>) =>
  console.log(`[worker] ${message}${meta ? " " + JSON.stringify(meta) : ""}`);

async function sweep(): Promise<void> {
  try {
    const expiry = await closeExpiredSessions(conn.db);
    const suspended = await closeSuspendedAgentSessions(conn.db);
    const records = await issueRecords({ db: conn.db, s3, s3Bucket: config.S3_BUCKET, signer, mailer, publicUrl: config.PUBLIC_URL, log });
    const snapshot = await recordActivitySnapshot(conn.db, { log });
    if (expiry.expired || expiry.idleClosed || suspended.closed || suspended.cancelled || records.issued || records.skipped) {
      log("sweep", { ...expiry, ...suspended, ...records });
    }
    if (snapshot.written) log("activity snapshot written");
  } catch (err) {
    log("sweep failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

const health = buildHealthServer(() => conn.db.command({ ping: 1 }));
await health.listen({ host: "0.0.0.0", port: config.PORT });
log(`started, polling every ${config.WORKER_POLL_INTERVAL_MS}ms`);

const interval = setInterval(sweep, config.WORKER_POLL_INTERVAL_MS);
void sweep();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    clearInterval(interval);
    await health.close();
    await conn.close();
    process.exit(0);
  });
}
