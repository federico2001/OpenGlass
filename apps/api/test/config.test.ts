import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  PUBLIC_URL: "https://localhost",
  MONGODB_URI: "mongodb://mongo:27017/openglass?replicaSet=rs0",
  S3_ENDPOINT: "http://minio:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "openglass-records",
  SIGNER: "local",
  EMAIL: "smtp",
  SMTP_URL: "smtp://mailpit:1025",
};

describe("loadConfig", () => {
  it("parses a complete local config", () => {
    const c = loadConfig({ ...base, S3_FORCE_PATH_STYLE: "true" });
    expect(c.PORT).toBe(3000);
    expect(c.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("requires KMS_KEY_ID when SIGNER=kms and SMTP_URL when EMAIL=smtp", () => {
    expect(() => loadConfig({ ...base, SIGNER: "kms" })).toThrow(/KMS_KEY_ID/);
    expect(() => loadConfig({ ...base, SMTP_URL: undefined })).toThrow(/SMTP_URL/);
    expect(loadConfig({ ...base, SIGNER: "kms", KMS_KEY_ID: "alias/openglass", EMAIL: "ses", SMTP_URL: undefined }).SIGNER).toBe("kms");
  });

  it("rejects unknown signer/email values and a missing MONGODB_URI", () => {
    expect(() => loadConfig({ ...base, SIGNER: "hsm" })).toThrow(/SIGNER/);
    expect(() => loadConfig({ ...base, MONGODB_URI: undefined })).toThrow(/MONGODB_URI/);
  });
});
