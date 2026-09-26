import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { createOwnerSessionCookie, insertTestOwner, testServerDeps } from "../helpers.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["owners", "web_sessions", "integration_votes", "integration_requests", "integration_status", "rate_limits"]) {
    await t.db.collection(c).deleteMany({});
  }
});

function app() {
  return buildServer({ ...testServerDeps(t), healthChecks: {} });
}

const JSON_HEADERS = { origin: "https://localhost", "content-type": "application/json" };

describe("GET /v1/integrations", () => {
  it("is public, lists the static catalog, and reports zero votes / hasVoted=false when unauthenticated", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/integrations" });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { slug: string; status: string; voteCount: number; hasVoted: boolean }[];
    expect(items.length).toBeGreaterThan(0);
    const langchain = items.find((i) => i.slug === "langchain")!;
    expect(langchain.voteCount).toBe(0);
    expect(langchain.hasVoted).toBe(false);
    // The catalog's own honest defaults: these two already ship, everything else doesn't yet.
    expect(items.find((i) => i.slug === "opentelemetry")!.status).toBe("native");
    expect(items.find((i) => i.slug === "mcp")!.status).toBe("native");
  });

  it("reports hasVoted=true for a signed-in owner who already voted", async () => {
    const owner = await insertTestOwner(t.db, "voter@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    await app().inject({ method: "POST", url: "/v1/integrations/crewai/vote", headers: { cookie, ...JSON_HEADERS } });

    const res = await app().inject({ method: "GET", url: "/v1/integrations", headers: { cookie } });
    const items = res.json().items as { slug: string; hasVoted: boolean; voteCount: number }[];
    expect(items.find((i) => i.slug === "crewai")!.hasVoted).toBe(true);
    expect(items.find((i) => i.slug === "crewai")!.voteCount).toBe(1);
  });
});

describe("POST/DELETE /v1/integrations/:slug/vote", () => {
  it("requires auth", async () => {
    const res = await app().inject({ method: "POST", url: "/v1/integrations/crewai/vote", headers: JSON_HEADERS });
    expect(res.statusCode).toBe(401);
  });

  it("404s for an unknown slug", async () => {
    const owner = await insertTestOwner(t.db, "unknown@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const res = await app().inject({ method: "POST", url: "/v1/integrations/not-a-real-framework/vote", headers: { cookie, ...JSON_HEADERS } });
    expect(res.statusCode).toBe(404);
  });

  it("counts one vote per owner and rejects a second vote for the same framework", async () => {
    const owner = await insertTestOwner(t.db, "dupe@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);

    const first = await app().inject({ method: "POST", url: "/v1/integrations/autogen/vote", headers: { cookie, ...JSON_HEADERS } });
    expect(first.statusCode).toBe(201);
    expect(first.json().voteCount).toBe(1);

    const second = await app().inject({ method: "POST", url: "/v1/integrations/autogen/vote", headers: { cookie, ...JSON_HEADERS } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("already_voted");
  });

  it("lets an owner remove their own vote", async () => {
    const owner = await insertTestOwner(t.db, "unvoter@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    await app().inject({ method: "POST", url: "/v1/integrations/llamaindex/vote", headers: { cookie, ...JSON_HEADERS } });

    const del = await app().inject({ method: "DELETE", url: "/v1/integrations/llamaindex/vote", headers: { cookie, ...JSON_HEADERS } });
    expect(del.statusCode).toBe(200);
    expect(del.json().voteCount).toBe(0);

    // removing a vote that doesn't exist is a no-op, not an error
    const again = await app().inject({ method: "DELETE", url: "/v1/integrations/llamaindex/vote", headers: { cookie, ...JSON_HEADERS } });
    expect(again.statusCode).toBe(200);
  });

  it("two different owners each get their own vote counted", async () => {
    const a = await insertTestOwner(t.db, "voter-a@example.com");
    const b = await insertTestOwner(t.db, "voter-b@example.com");
    const cookieA = await createOwnerSessionCookie(t.db, a._id);
    const cookieB = await createOwnerSessionCookie(t.db, b._id);

    await app().inject({ method: "POST", url: "/v1/integrations/vercel-ai-sdk/vote", headers: { cookie: cookieA, ...JSON_HEADERS } });
    const res = await app().inject({ method: "POST", url: "/v1/integrations/vercel-ai-sdk/vote", headers: { cookie: cookieB, ...JSON_HEADERS } });
    expect(res.json().voteCount).toBe(2);
  });
});

describe("POST /v1/integrations/requests", () => {
  it("requires auth", async () => {
    const res = await app().inject({ method: "POST", url: "/v1/integrations/requests", headers: JSON_HEADERS, payload: { frameworkName: "Haystack" } });
    expect(res.statusCode).toBe(401);
  });

  it("submits a request tied to the signed-in owner's email", async () => {
    const owner = await insertTestOwner(t.db, "requester@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const res = await app().inject({
      method: "POST",
      url: "/v1/integrations/requests",
      headers: { cookie, ...JSON_HEADERS },
      payload: { frameworkName: "Haystack", frameworkUrl: "https://haystack.deepset.ai/", note: "We use it for retrieval." },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().request.requesterEmail).toBe("requester@example.com");
    expect(res.json().request.status).toBe("new");
  });
});

describe("admin routes", () => {
  it("403s a signed-in owner who isn't in ADMIN_EMAILS", async () => {
    const owner = await insertTestOwner(t.db, "not-admin@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);
    const res = await app().inject({ method: "GET", url: "/v1/admin/integrations/requests", headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it("401s an unauthenticated caller", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/admin/integrations/requests" });
    expect(res.statusCode).toBe(401);
  });

  it("lets an admin list requests and update a framework's status", async () => {
    const requester = await insertTestOwner(t.db, "req2@example.com");
    const requesterCookie = await createOwnerSessionCookie(t.db, requester._id);
    await app().inject({
      method: "POST",
      url: "/v1/integrations/requests",
      headers: { cookie: requesterCookie, ...JSON_HEADERS },
      payload: { frameworkName: "Haystack" },
    });

    // testServerDeps() allowlists admin@example.com — see apps/api/test/helpers.ts
    const admin = await insertTestOwner(t.db, "admin@example.com");
    const adminCookie = await createOwnerSessionCookie(t.db, admin._id);

    const list = await app().inject({ method: "GET", url: "/v1/admin/integrations/requests", headers: { cookie: adminCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].frameworkName).toBe("Haystack");

    const patch = await app().inject({
      method: "PATCH",
      url: "/v1/admin/integrations/crewai/status",
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: { status: "in_progress" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe("in_progress");

    const catalog = await app().inject({ method: "GET", url: "/v1/integrations" });
    expect(catalog.json().items.find((i: { slug: string }) => i.slug === "crewai").status).toBe("in_progress");
  });

  it("404s a status update for an unknown slug", async () => {
    const admin = await insertTestOwner(t.db, "admin@example.com");
    const adminCookie = await createOwnerSessionCookie(t.db, admin._id);
    const res = await app().inject({
      method: "PATCH",
      url: "/v1/admin/integrations/not-a-real-framework/status",
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: { status: "available" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s an invalid status value", async () => {
    const admin = await insertTestOwner(t.db, "admin@example.com");
    const adminCookie = await createOwnerSessionCookie(t.db, admin._id);
    const res = await app().inject({
      method: "PATCH",
      url: "/v1/admin/integrations/crewai/status",
      headers: { cookie: adminCookie, ...JSON_HEADERS },
      payload: { status: "shipped" },
    });
    expect(res.statusCode).toBe(400);
  });
});
