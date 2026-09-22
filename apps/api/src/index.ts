import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { connectFromEnv, migrate } from "@openglass/db";
import { loadConfig } from "./config.js";
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

const app = buildServer({
  logger: { level: config.LOG_LEVEL },
  healthChecks: {
    mongo: () => conn.db.command({ ping: 1 }),
    s3: () => s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET })),
  },
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
