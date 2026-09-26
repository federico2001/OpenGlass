import { attestationsRepository } from "@openglass/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { closeExpiredAttestations } from "../../src/jobs/closeExpiredAttestations.js";
import { buildActiveAttestation, testSigner } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["agents", "owners", "attestations", "messages"]) await t.db.collection(c).deleteMany({});
});

describe("closeExpiredAttestations", () => {
  it("moves an idle active attestation to closing with reason idle_timeout", async () => {
    const { attestation } = await buildActiveAttestation(t.db, { signer: testSigner() });
    const attestations = attestationsRepository(t.db);
    await attestations.update(attestation._id, { expiresAt: new Date(Date.now() - 1000) });

    const result = await closeExpiredAttestations(t.db);
    expect(result.idleClosed).toBe(1);

    const updated = await attestations.findById(attestation._id);
    expect(updated!.status).toBe("closing");
    expect(updated!.closing!.reason).toBe("idle_timeout");
    expect(updated!.closing!.requestedBy).toBeNull();
  });

  it("leaves unexpired attestations untouched", async () => {
    const { attestation } = await buildActiveAttestation(t.db, { signer: testSigner() });
    const result = await closeExpiredAttestations(t.db);
    expect(result.idleClosed).toBe(0);
    expect((await attestationsRepository(t.db).findById(attestation._id))!.status).toBe("active");
  });
});
