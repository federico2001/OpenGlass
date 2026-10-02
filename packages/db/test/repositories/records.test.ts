import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/migrate.js";
import { records, type RecordDoc } from "../../src/models/collections.js";
import { approveUnseal, disputeRecord, requestUnseal, shredContent } from "../../src/repositories/records.js";
import { validDocs } from "../fixtures.js";
import { openTestDb } from "../testDb.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeEach(async () => {
  t = await openTestDb();
  const migrationsDir = await mkdtemp(path.join(tmpdir(), "og-migrations-"));
  await migrate(t.db, t.client, { migrationsDir }); // creates every collection + its validator
});
afterEach(async () => {
  await t.cleanup();
});

const OWNER_A = "own_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const OWNER_B = "own_01J8Z3K4M5N6P7Q8R9S0T1V2W4";

function baseRecord(overrides: Partial<RecordDoc> = {}): RecordDoc {
  return { ...(validDocs.records as unknown as RecordDoc), participantOwnerIds: [OWNER_A, OWNER_B], ...overrides };
}

async function insert(doc: RecordDoc): Promise<void> {
  await t.db.collection<RecordDoc>(records.name).insertOne(doc);
}

describe("records repository: shredContent (realignment R1, append-only exception)", () => {
  it("clears the wrapped data key and marks shredded, leaving statement/evidence untouched", async () => {
    const doc = baseRecord({
      visibility: "private",
      encryption: { dataKeyCiphertext: "d2lyZWQ", kmsKeyId: null, shredded: false, shreddedAt: null, shreddedReason: null },
    });
    await insert(doc);

    const ok = await shredContent(t.db, doc._id, "retention_expired");
    expect(ok).toBe(true);

    const after = await t.db.collection<RecordDoc>(records.name).findOne({ _id: doc._id });
    expect(after!.encryption).toEqual({ dataKeyCiphertext: null, kmsKeyId: null, shredded: true, shreddedAt: expect.any(Date), shreddedReason: "retention_expired" });
    expect(after!.statement).toEqual(doc.statement);
    expect(after!.statementHash).toBe(doc.statementHash);
    expect(after!.evidence).toEqual(doc.evidence);
  });

  it("is idempotent — shredding an already-shredded record reports success without changing shreddedAt", async () => {
    const doc = baseRecord({
      visibility: "private",
      encryption: { dataKeyCiphertext: "d2lyZWQ", kmsKeyId: "kms-key-1", shredded: false, shreddedAt: null, shreddedReason: null },
    });
    await insert(doc);

    expect(await shredContent(t.db, doc._id, "retention_expired")).toBe(true);
    const firstShreddedAt = (await t.db.collection<RecordDoc>(records.name).findOne({ _id: doc._id }))!.encryption!.shreddedAt;

    expect(await shredContent(t.db, doc._id, "owner_deleted")).toBe(true);
    const second = await t.db.collection<RecordDoc>(records.name).findOne({ _id: doc._id });
    expect(second!.encryption!.shreddedAt).toEqual(firstShreddedAt);
    expect(second!.encryption!.shreddedReason).toBe("retention_expired"); // unchanged by the second call
  });

  it("reports false for a record that was never private/encrypted", async () => {
    const doc = baseRecord({ visibility: "shared" });
    await insert(doc);
    expect(await shredContent(t.db, doc._id, "retention_expired")).toBe(false);
  });
});

describe("records repository: sealed unseal/dispute state machine (realignment R1)", () => {
  function sealedRecord(overrides: Partial<RecordDoc> = {}): RecordDoc {
    return baseRecord({
      visibility: "sealed",
      sealedState: { status: "sealed", requestedBy: null, approvals: [], unsealedAt: null, disputedBy: null, disputedAt: null },
      ...overrides,
    });
  }

  it("requestUnseal moves sealed -> unseal_requested with the requester's own implicit approval", async () => {
    const doc = sealedRecord();
    await insert(doc);
    const updated = await requestUnseal(t.db, doc._id, OWNER_A);
    expect(updated!.sealedState).toEqual({ status: "unseal_requested", requestedBy: OWNER_A, approvals: [OWNER_A], unsealedAt: null, disputedBy: null, disputedAt: null });
  });

  it("requestUnseal is a no-op (returns null) when not currently plain sealed", async () => {
    const doc = sealedRecord({ sealedState: { status: "unseal_requested", requestedBy: OWNER_A, approvals: [OWNER_A], unsealedAt: null, disputedBy: null, disputedAt: null } });
    await insert(doc);
    expect(await requestUnseal(t.db, doc._id, OWNER_B)).toBeNull();
  });

  it("approveUnseal flips to unsealed once every participant owner has approved", async () => {
    const doc = sealedRecord({ sealedState: { status: "unseal_requested", requestedBy: OWNER_A, approvals: [OWNER_A], unsealedAt: null, disputedBy: null, disputedAt: null } });
    await insert(doc);

    const updated = await approveUnseal(t.db, doc._id, OWNER_B);
    expect(updated!.sealedState!.status).toBe("unsealed");
    expect(updated!.sealedState!.approvals.sort()).toEqual([OWNER_A, OWNER_B].sort());
    expect(updated!.sealedState!.unsealedAt).toBeInstanceOf(Date);
  });

  it("approveUnseal is idempotent for an owner who already approved and doesn't complete the set alone", async () => {
    const doc = sealedRecord({ sealedState: { status: "unseal_requested", requestedBy: OWNER_A, approvals: [OWNER_A], unsealedAt: null, disputedBy: null, disputedAt: null } });
    await insert(doc);

    const updated = await approveUnseal(t.db, doc._id, OWNER_A);
    expect(updated!.sealedState!.status).toBe("unseal_requested");
    expect(updated!.sealedState!.approvals).toEqual([OWNER_A]);
  });

  it("disputeRecord on a legacy sealed record flags it and force-unseals it (the rule it was issued under)", async () => {
    const doc = sealedRecord();
    await insert(doc);
    const updated = await disputeRecord(t.db, doc._id, OWNER_B);
    expect(updated!.dispute).toEqual({ disputedBy: OWNER_B, disputedAt: expect.any(Date) });
    expect(updated!.sealedState).toEqual({ status: "disputed", requestedBy: null, approvals: [], unsealedAt: null, disputedBy: OWNER_B, disputedAt: expect.any(Date) });
  });

  it("disputeRecord on an already-unsealed sealed record flags it without touching sealedState", async () => {
    const sealedState = { status: "unsealed" as const, requestedBy: OWNER_A, approvals: [OWNER_A, OWNER_B], unsealedAt: new Date(), disputedBy: null, disputedAt: null };
    const doc = sealedRecord({ sealedState });
    await insert(doc);
    const updated = await disputeRecord(t.db, doc._id, OWNER_A);
    expect(updated!.dispute!.disputedBy).toBe(OWNER_A);
    expect(updated!.sealedState!.status).toBe("unsealed");
  });
});

describe("records repository: a sole owner opening a legacy sealed one-party record", () => {
  it("requestUnseal then approveUnseal by the only participant owner unseals it", async () => {
    const agents = (validDocs.records as unknown as RecordDoc).participantAgentIds;
    const doc = baseRecord({
      visibility: "sealed",
      sealedState: { status: "sealed", requestedBy: null, approvals: [], unsealedAt: null, disputedBy: null, disputedAt: null },
      participantOwnerIds: [OWNER_A],
      participantAgentIds: [agents[0]!],
    });
    await insert(doc);
    const requested = await requestUnseal(t.db, doc._id, OWNER_A);
    expect(requested!.sealedState!.status).toBe("unseal_requested");
    const approved = await approveUnseal(t.db, doc._id, OWNER_A);
    expect(approved!.sealedState!.status).toBe("unsealed");
  });
});

describe("records repository: disputeRecord on shared/private records", () => {
  it.each(["shared", "private"] as const)("flags a %s record and changes nothing else", async (visibility) => {
    const doc = baseRecord({ visibility });
    await insert(doc);
    const updated = await disputeRecord(t.db, doc._id, OWNER_A);
    expect(updated!.dispute).toEqual({ disputedBy: OWNER_A, disputedAt: expect.any(Date) });
    const { dispute: _d, ...rest } = updated!;
    expect(rest).toEqual(doc);
  });

  it("is set once: a second dispute returns null and keeps the first owner's", async () => {
    const doc = baseRecord({ visibility: "shared" });
    await insert(doc);
    expect(await disputeRecord(t.db, doc._id, OWNER_A)).not.toBeNull();
    expect(await disputeRecord(t.db, doc._id, OWNER_B)).toBeNull();
    const stored = await t.db.collection<RecordDoc>(records.name).findOne({ _id: doc._id });
    expect(stored!.dispute!.disputedBy).toBe(OWNER_A);
  });
});
