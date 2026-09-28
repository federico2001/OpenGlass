/**
 * Realignment R2 (docs/SPEC.md §14.1): backfills `agents.homepageDomain` for every
 * already-registered agent that has a `meta.homepage` set, so `GET /v1/lookup?domain=`
 * can find agents registered before this field existed too, not just new ones. Purely an
 * index/read-path convenience — never a claim of ownership on its own, so unlike a signed
 * protocol field this is fine to backfill after the fact.
 *
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
export const up = async (db, client) => {
  const cursor = db
    .collection("agents")
    .find({ "meta.homepage": { $exists: true, $type: "string" }, homepageDomain: { $exists: false } }, { projection: { _id: 1, meta: 1 } });
  for await (const agent of cursor) {
    const domain = domainFromHomepage(agent.meta && agent.meta.homepage);
    await db.collection("agents").updateOne({ _id: agent._id }, { $set: { homepageDomain: domain } });
  }
};

/**
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
export const down = async (db, client) => {
  await db.collection("agents").updateMany({}, { $unset: { homepageDomain: "" } });
};

/** Deliberately minimal re-implementation of apps/api/src/domain/domainVerification.ts's
 * `domainFromHomepage` — a plain-JS migration file shouldn't import application TS source,
 * and this logic is small enough that duplicating it once here is clearer than wiring up a
 * build-order dependency for it. */
function domainFromHomepage(homepage) {
  if (!homepage) return null;
  try {
    const url = new URL(homepage);
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    const bareHost = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (/^[\d.]+$/.test(bareHost) || bareHost.includes(":")) return null; // IPv4/IPv6 literal
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return null;
    return hostname;
  } catch {
    return null;
  }
}
