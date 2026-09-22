#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { OpenGlassStack } from "../lib/openglass-stack.js";

// Configuration comes from env vars (see infra/README.md).
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see infra/README.md)`);
  return v;
}

const app = new App();
new OpenGlassStack(app, "OpenGlass", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  domainName: env("OG_DOMAIN"),
  hostedZoneId: env("OG_HOSTED_ZONE_ID"),
  hostedZoneName: env("OG_HOSTED_ZONE_NAME"),
  githubRepo: process.env.OG_GITHUB_REPO ?? "federico2001/OpenGlass",
  budgetEmail: env("OG_BUDGET_EMAIL"),
  acmeEmail: env("OG_ACME_EMAIL"),
  createGithubOidcProvider: process.env.OG_CREATE_GITHUB_OIDC_PROVIDER !== "false",
  objectLockMode: process.env.OG_OBJECT_LOCK_MODE === "COMPLIANCE" ? "COMPLIANCE" : "GOVERNANCE",
});
