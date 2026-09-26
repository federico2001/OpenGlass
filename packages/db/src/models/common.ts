import { ObjectId } from "mongodb";
import { z } from "zod";
import { withBson } from "../jsonSchema.js";

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const prefixedId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${ULID}$`));

export const OwnerId = prefixedId("own");
export const AgentId = prefixedId("agt");
export const KeyId = prefixedId("key");
export const SessionId = prefixedId("ses");
export const InviteId = prefixedId("inv");
export const MessageId = prefixedId("msg");
export const RecordId = prefixedId("rec");
export const ViewerGrantId = prefixedId("vwg");

/** Agent key ids (`key_…`) or platform key ids (`plat_…`). */
export const Kid = z.string().regex(new RegExp(`^(key_${ULID}|plat_[a-z0-9_-]{1,32})$`));
export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** RFC 3339 UTC with milliseconds, as used inside signed objects. */
export const IsoTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

export const Signature = z.strictObject({
  alg: z.enum(["Ed25519", "ECDSA_P256_SHA256"]),
  kid: Kid,
  sig: Base64Url,
});
export type Signature = z.infer<typeof Signature>;

export const ObjectIdSchema = withBson(
  z.custom<ObjectId>((v) => v instanceof ObjectId, { message: "Expected ObjectId" }),
  { bsonType: "objectId" },
);
