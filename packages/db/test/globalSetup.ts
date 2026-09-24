import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { MongoDBContainer, type StartedMongoDBContainer } from "@testcontainers/mongodb";
import type { TestProject } from "vitest/node";

import type {} from "./testDb.js"; // ProvidedContext typing
import type {} from "./testS3.js"; // ProvidedContext typing

/**
 * Tests run against MONGODB_URI/S3_TEST_ENDPOINT when set (e.g. CI pointed at real
 * infra), otherwise against throwaway containers (a mongo:7 replica set, a MinIO
 * instance) that are removed afterwards. Nothing else differs between the two.
 */
export default async function setup(project: TestProject) {
  const teardowns: (() => Promise<void>)[] = [];

  if (process.env.MONGODB_URI) {
    project.provide("mongoUri", process.env.MONGODB_URI);
  } else {
    const container: StartedMongoDBContainer = await new MongoDBContainer("mongo:7").start();
    project.provide("mongoUri", `${container.getConnectionString()}/openglass?directConnection=true`);
    teardowns.push(async () => {
      await container.stop();
    });
  }

  if (process.env.S3_TEST_ENDPOINT) {
    project.provide("s3Endpoint", process.env.S3_TEST_ENDPOINT);
    project.provide("s3AccessKeyId", process.env.S3_TEST_ACCESS_KEY_ID ?? "minioadmin");
    project.provide("s3SecretAccessKey", process.env.S3_TEST_SECRET_ACCESS_KEY ?? "minioadmin");
  } else {
    // Official minio/minio images are discontinued (see README/docker-compose.yml) —
    // use the same maintained community build the rest of the stack runs.
    const container: StartedMinioContainer = await new MinioContainer("pgsty/minio:RELEASE.2026-08-04T00-00-00Z").start();
    project.provide("s3Endpoint", container.getConnectionUrl());
    project.provide("s3AccessKeyId", container.getUsername());
    project.provide("s3SecretAccessKey", container.getPassword());
    teardowns.push(async () => {
      await container.stop();
    });
  }

  return async () => {
    for (const teardown of teardowns) await teardown();
  };
}
