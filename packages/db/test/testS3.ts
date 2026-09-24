import { randomBytes } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    s3Endpoint: string;
    s3AccessKeyId: string;
    s3SecretAccessKey: string;
  }
}

/** Opens an S3 client against the shared test MinIO instance and creates a fresh,
 * uniquely-named bucket so test files can't interfere with each other. */
export async function openTestS3(): Promise<{ client: S3Client; bucket: string; cleanup: () => Promise<void> }> {
  const client = new S3Client({
    endpoint: inject("s3Endpoint"),
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: inject("s3AccessKeyId"), secretAccessKey: inject("s3SecretAccessKey") },
  });
  const bucket = `og-test-${randomBytes(6).toString("hex")}`;
  // Object Lock must be enabled at bucket creation (S3 and MinIO both refuse to turn it on
  // later) — needed for the premium extend-retention route's PutObjectRetention/
  // GetObjectRetention calls to work in tests, matching the real bucket's `--with-lock`.
  await client.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  return {
    client,
    bucket,
    cleanup: async () => {
      client.destroy();
    },
  };
}
