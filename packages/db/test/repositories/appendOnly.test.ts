import { describe, expect, it } from "vitest";
import * as messagesRepo from "../../src/repositories/messages.js";
import * as recordsRepo from "../../src/repositories/records.js";

/**
 * `messages` and `records` are append-only (SPEC §3, CLAUDE.md: "the code never updates
 * or deletes a document in `messages` or `records`"). This test is the enforcement
 * mechanism D12 describes: it fails the build the moment either module exports anything
 * other than an insert or a find. Never widen these allow-lists to add an update/delete —
 * the documented exceptions are `records.ts`'s `shredContent`, `requestUnseal`,
 * `approveUnseal`, and `disputeSeal` (realignment R1, docs/SPEC.md §13), allow-listed by
 * exact name below: each touches only one access-control sub-field (`encryption` or
 * `sealedState`), never `statement`/`evidence`/anything a signature or hash covers. Don't
 * widen their allowance, and don't add another like them without the same scrutiny.
 */

const ALLOWED_MESSAGES_EXPORTS = new Set([
  "insertMessage",
  "findMessagesBySession",
  "findAllMessagesBySession",
  "findMessageByHash",
  "findRecentMessagesBySessions",
]);
const RECORDS_MUTATION_EXCEPTIONS = new Set(["shredContent", "requestUnseal", "approveUnseal", "disputeSeal"]);
const ALLOWED_RECORDS_EXPORTS = new Set([
  "insertRecord", "findRecordById", "findRecordBySession", "listRecordsForOwner", "listRecordsForAgents", "DUPLICATE_KEY_ERROR_CODE",
  "ShredReason", ...RECORDS_MUTATION_EXCEPTIONS,
]);

describe("append-only enforcement", () => {
  it("messages.ts exports only insert/find functions (plus documented constants)", () => {
    const exportNames = Object.keys(messagesRepo);
    for (const name of exportNames) {
      expect(ALLOWED_MESSAGES_EXPORTS.has(name), `unexpected export from messages.ts: ${name}`).toBe(true);
      expect(name, "messages.ts must never export an update/delete function").not.toMatch(/^(update|delete|remove|set)/i);
    }
  });

  it("records.ts exports only insert/find functions, plus the documented sealing/shredding exceptions", () => {
    const exportNames = Object.keys(recordsRepo);
    for (const name of exportNames) {
      expect(ALLOWED_RECORDS_EXPORTS.has(name), `unexpected export from records.ts: ${name}`).toBe(true);
      if (RECORDS_MUTATION_EXCEPTIONS.has(name)) continue;
      expect(name, "records.ts must never export an update/delete function (other than the allow-listed exceptions)").not.toMatch(
        /^(update|delete|remove|set)/i,
      );
    }
  });
});
