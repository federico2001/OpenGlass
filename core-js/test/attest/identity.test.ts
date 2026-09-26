import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateIdentity, persistIdentity, readIdentity } from "../../src/attest/identity.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "og-core-identity-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadOrCreateIdentity", () => {
  it("generates and persists a fresh identity on first use", () => {
    const path = join(dir, "identity.json");
    const identity = loadOrCreateIdentity(path);
    expect(identity.kid).toBe("new");
    expect(identity.privateKey).toHaveLength(32);
    expect(identity.publicKey).toHaveLength(32);
  });

  it("loads the same identity on a second call", () => {
    const path = join(dir, "identity.json");
    const first = loadOrCreateIdentity(path);
    const second = loadOrCreateIdentity(path);
    expect(second.privateKey).toEqual(first.privateKey);
    expect(second.publicKey).toEqual(first.publicKey);
  });

  it("round-trips agentId/kid persisted after registration", () => {
    const path = join(dir, "identity.json");
    const identity = loadOrCreateIdentity(path);
    persistIdentity(path, { ...identity, agentId: "agt_test123", kid: "key_test123" });
    const reloaded = readIdentity(path);
    expect(reloaded.agentId).toBe("agt_test123");
    expect(reloaded.kid).toBe("key_test123");
    expect(reloaded.privateKey).toEqual(identity.privateKey);
  });

  it("creates missing parent directories", () => {
    const path = join(dir, "nested", "dir", "identity.json");
    const identity = loadOrCreateIdentity(path);
    expect(readIdentity(path).publicKey).toEqual(identity.publicKey);
  });
});
