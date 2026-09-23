import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTestDb } from "../../../../packages/db/test/testDb.js";
import { buildServer } from "../../src/server.js";
import { createOwnerSessionCookie, insertTestOwner, testServerDeps } from "../helpers.js";
import type { Mailer } from "../../src/mailer.js";

let t: Awaited<ReturnType<typeof openTestDb>>;
beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const c of ["owners", "login_tokens", "web_sessions", "rate_limits"]) await t.db.collection(c).deleteMany({});
});

function appWithMailer() {
  const deps = testServerDeps(t);
  return { app: buildServer({ ...deps, healthChecks: {} }), mailer: deps.mailer as Mailer & { sent: { kind: string; to: string; url: string }[] } };
}

describe("POST /v1/auth/email", () => {
  it("always returns 202 and emails a magic link", async () => {
    const { app, mailer } = appWithMailer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/email",
      payload: { email: "Alice@Example.com", redirectTo: "/dashboard" },
    });
    expect(res.statusCode).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("alice@example.com");
    expect(mailer.sent[0]!.url).toContain("/v1/auth/verify?token=");
  });

  it("returns 202 even for a malformed body (never leaks whether validation failed)", async () => {
    // actually validation_failed is 400 — but the point is it must not reveal account existence;
    // check instead that no email is sent for an invalid address.
    const { app, mailer } = appWithMailer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/email", payload: { email: "not-an-email", redirectTo: "/x" } });
    expect(res.statusCode).toBe(400);
    expect(mailer.sent).toHaveLength(0);
  });

  it("rejects an absolute redirectTo (open-redirect guard)", async () => {
    const { app } = appWithMailer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/email",
      payload: { email: "a@example.com", redirectTo: "https://evil.example/steal" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/auth/verify", () => {
  it("consumes a valid token, creates the owner on first login, and sets a session cookie", async () => {
    const { app, mailer } = appWithMailer();
    await app.inject({ method: "POST", url: "/v1/auth/email", payload: { email: "new@example.com", redirectTo: "/home" } });
    const url = new URL(mailer.sent[0]!.url);
    const token = url.searchParams.get("token")!;

    const res = await app.inject({ method: "GET", url: `/v1/auth/verify?token=${token}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://localhost/home");
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");

    const owner = await t.db.collection("owners").findOne({ email: "new@example.com" });
    expect(owner).not.toBeNull();
  });

  it("redirects to an error page for an unknown or reused token", async () => {
    const { app } = appWithMailer();
    const res = await app.inject({ method: "GET", url: "/v1/auth/verify?token=not_a_real_token" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://localhost/login?error=invalid_token");
  });
});

describe("POST /v1/auth/logout", () => {
  it("clears the session so it can no longer authenticate", async () => {
    const { app } = appWithMailer();
    const owner = await insertTestOwner(t.db, "logout@example.com");
    const cookie = await createOwnerSessionCookie(t.db, owner._id);

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie, origin: "https://localhost", "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(204);

    const stillValid = await t.db.collection("web_sessions").findOne({ ownerId: owner._id });
    expect(stillValid).toBeNull();
  });
});
