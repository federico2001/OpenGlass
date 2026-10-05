import {
  attestationsRepository,
  canonicalizeToBytes,
  hex,
  hexToBytes,
  insertFetchWitness,
  newId,
  sha256,
  type AgentDoc,
  type FetchWitnessDoc,
  type PlatformSigner,
} from "@openglass/db";
import type { Db, MongoClient } from "mongodb";
import { MAX_REQUEST_BODY_BYTES, parseWitnessUrl, performWitnessFetch as realPerformWitnessFetch, type WitnessFetcher } from "./witnessFetch.js";

export interface AppendFetchWitnessError {
  status: number;
  code: string;
  message: string;
}

export type AppendFetchWitnessResult = { ok: true; witness: FetchWitnessDoc } | { ok: false; error: AppendFetchWitnessError };

export interface AppendFetchWitnessInput {
  url: string;
  method?: "GET" | "POST";
  /** Required for POST (a JSON value — the A2A/JSON-RPC envelope to send, say), forbidden
   * for GET. Serialized with the same canonical JSON the hash chain uses everywhere else,
   * so the bytes actually sent over the wire are exactly the bytes the platform's
   * signature attests to — never a separate, possibly-divergent `JSON.stringify`. */
  body?: unknown;
}

/** The `fetch_witnesses` counterpart to `appendMessage`/`appendAttestationEvent` — but
 * there's no agent signature to verify here (the platform is the one making the fetch, so
 * it's the platform's own direct claim, not something an agent authored and signed). The
 * outbound HTTP call happens before any DB write, since it's the slow part and must never
 * run inside a transaction; the insert-and-advance-head pair after it is transactional,
 * same as appendMessage.ts, so a crash between the two never leaves an orphaned witness or
 * a bumped head with nothing to match it. */
export async function appendFetchWitness(
  deps: { db: Db; mongoClient: MongoClient; signer: PlatformSigner; performWitnessFetch?: WitnessFetcher },
  agentDoc: AgentDoc,
  attestationId: string,
  input: AppendFetchWitnessInput,
): Promise<AppendFetchWitnessResult> {
  const performWitnessFetch = deps.performWitnessFetch ?? realPerformWitnessFetch;
  const attestations = attestationsRepository(deps.db);
  const attestation = await attestations.findById(attestationId);
  if (!attestation || attestation.attestor.agentId !== agentDoc._id) {
    return { ok: false, error: { status: 404, code: "not_found", message: "Attestation not found" } };
  }
  if (attestation.status !== "active") {
    return { ok: false, error: { status: 409, code: "attestation_not_active", message: "Attestation is not active" } };
  }

  const url = parseWitnessUrl(input.url);
  if (!url) return { ok: false, error: { status: 422, code: "url_invalid", message: "url must be an https URL on a bare hostname, with no port or credentials" } };

  const method = input.method ?? "GET";
  if (method === "POST" && input.body === undefined) {
    return { ok: false, error: { status: 422, code: "body_required_for_post", message: "body is required when method is POST" } };
  }
  if (method === "GET" && input.body !== undefined) {
    return { ok: false, error: { status: 422, code: "body_not_allowed_for_get", message: "body is not allowed when method is GET" } };
  }

  let requestBodyBytes: Buffer | undefined;
  let requestInfo: FetchWitnessDoc["request"] = null;
  if (method === "POST") {
    requestBodyBytes = canonicalizeToBytes(input.body);
    if (requestBodyBytes.byteLength > MAX_REQUEST_BODY_BYTES) {
      return { ok: false, error: { status: 413, code: "body_too_large", message: `body exceeds ${MAX_REQUEST_BODY_BYTES} bytes` } };
    }
    requestInfo = {
      contentType: "application/json",
      bodySha256: hex(sha256(requestBodyBytes)),
      bodyBytes: requestBodyBytes.byteLength,
      bodyText: requestBodyBytes.toString("utf8"),
    };
  }

  const expectedSeq = (attestation.lastWitnessSeq ?? 0) + 1;
  const expectedPrevHash = attestation.lastWitnessHash ?? attestation.genesisHash;
  const requestedAt = new Date();

  const fetched = await performWitnessFetch(url, { method, body: requestBodyBytes });
  if (!fetched.ok) return { ok: false, error: { status: 422, code: "url_unreachable", message: fetched.reason } };

  const fetchedAt = new Date();
  const signable = {
    attestationId,
    requestedBy: agentDoc._id,
    seq: expectedSeq,
    prevHash: expectedPrevHash,
    url: url.href,
    method,
    request: requestInfo,
    requestedAt: requestedAt.toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    response: fetched.response,
  };
  const hashBytes = sha256(Buffer.concat([hexToBytes(expectedPrevHash), canonicalizeToBytes(signable)]));
  const computedHash = hex(hashBytes);
  const platformSignature = await deps.signer.sign("fetch_witness", hashBytes);

  const doc: FetchWitnessDoc = {
    _id: newId("wfx"),
    attestationId,
    requestedBy: agentDoc._id,
    seq: expectedSeq,
    prevHash: expectedPrevHash,
    url: url.href,
    method,
    request: requestInfo,
    requestedAt,
    fetchedAt,
    response: fetched.response,
    hash: computedHash,
    platformSignature,
    domain: url.hostname,
  };

  const dbSession = deps.mongoClient.startSession();
  let conflict = false;
  try {
    await dbSession.withTransaction(async () => {
      await insertFetchWitness(deps.db, doc, { session: dbSession });
      const updated = await attestations.advanceWitnessHead(
        attestationId,
        attestation.lastWitnessSeq ?? 0,
        { lastWitnessSeq: expectedSeq, lastWitnessHash: computedHash },
        { session: dbSession },
      );
      if (!updated) {
        conflict = true;
        throw new Error("chain_conflict");
      }
    });
  } catch (err) {
    if (!conflict) throw err;
  } finally {
    await dbSession.endSession();
  }
  if (conflict) {
    return { ok: false, error: { status: 409, code: "chain_conflict", message: "The witness chain head has moved; retry" } };
  }

  return { ok: true, witness: doc };
}
