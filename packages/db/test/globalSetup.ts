import { MongoDBContainer, type StartedMongoDBContainer } from "@testcontainers/mongodb";
import type { TestProject } from "vitest/node";

import type {} from "./testDb.js"; // ProvidedContext typing

/**
 * Tests run against MONGODB_URI when it's set (e.g. an Atlas cluster), otherwise
 * against a throwaway mongo:7 replica-set container that's removed afterwards.
 * Nothing else about the database differs between the two.
 */
export default async function setup(project: TestProject) {
  if (process.env.MONGODB_URI) {
    project.provide("mongoUri", process.env.MONGODB_URI);
    return;
  }
  const container: StartedMongoDBContainer = await new MongoDBContainer("mongo:7").start();
  project.provide("mongoUri", `${container.getConnectionString()}/openglass?directConnection=true`);
  return async () => {
    await container.stop();
  };
}
