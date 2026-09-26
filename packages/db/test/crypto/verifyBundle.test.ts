import { describe, expect, it } from "vitest";
import { verifyBundle } from "../../src/crypto/verifyBundle.js";
import { buildTestBundle } from "./buildTestBundle.js";

describe("verifyBundle (SPEC §7.6)", () => {
  it("accepts a genuinely signed, well-formed bundle with zero errors", async () => {
    const { bundle } = await buildTestBundle();
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a bundle verified against the wrong trusted platform keys", async () => {
    const { bundle } = await buildTestBundle();
    const result = verifyBundle(bundle, []); // no trusted key can match `plat_test`
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("record_signature");
  });

  it("catches a corrupted record statement hash", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.record.statementHash = "0".repeat(64);
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(expect.arrayContaining(["statement_hash", "record_signature"]));
  });

  it("catches a record statement whose evidenceSha256 no longer matches the evidence", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.record.statement.evidenceSha256 = "1".repeat(64);
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("evidence_hash");
  });

  it("catches a forged offer signature", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.evidence.offerSignature!.sig = b.evidence.offerSignature!.sig.slice(0, -4) + "AAAA";
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("offer_signature");
  });

  it("catches a broken hash chain (tampered prevHash)", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.evidence.messages[0]!.envelope.prevHash = "2".repeat(64);
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    // Tampering inside `evidence` also breaks the evidence-hash commitment that covers
    // the whole object — a cascading failure is the correct, expected behavior here.
    const codes = result.errors.map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(["evidence_hash", "prev_hash", "hash"]));
    const chainError = result.errors.find((e) => e.code === "prev_hash");
    expect(chainError?.seq).toBe(1);
  });

  it("catches a payload that doesn't match its committed payloadHash (relay mode)", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.evidence.messages[0]!.payload = { proposal: { deliveryDate: "2099-01-01" } };
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("payload_hash");
  });

  it("catches a forged message countersignature", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.evidence.messages[0]!.platformSignature.sig = b.evidence.messages[0]!.platformSignature.sig.slice(0, -4) + "BBBB";
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("countersignature");
  });

  it("catches a close statement that disagrees with the record's headHash", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.evidence.close!.statement.headHash = "3".repeat(64);
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("close_statement");
  });

  it("catches a headSeq/messageCount that disagrees with the evidence's message list", async () => {
    const { bundle } = await buildTestBundle({
      tamper: (b) => {
        b.record.statement.headSeq = 2;
        b.record.statement.messageCount = 2;
      },
    });
    const result = verifyBundle(bundle, bundle.platformKeys);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("head_seq");
  });
});
