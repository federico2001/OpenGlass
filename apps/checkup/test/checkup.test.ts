import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { migrate } from "@openglass/db";
import { OpenGlassClient } from "openglass-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer as buildApiServer } from "../../api/src/server.js";
import { claimAgentDirectly, insertTestOwner, signedRequestHeaders, testIdentity, testServerDeps } from "../../api/test/helpers.js";
import { issueAttestationRecords } from "../../worker/src/jobs/issueAttestationRecords.js";
import { openTestDb } from "../../../packages/db/test/testDb.js";
import { openTestS3 } from "../../../packages/db/test/testS3.js";
import { AgentCardV03, AgentCardV1, ownAgentCard } from "../src/a2a.js";
import { PROBE_TEXT } from "../src/checks/endpoint.js";
import { OpenGlassLink } from "../src/openglass.js";
import { buildServer } from "../src/server.js";
import { INJECTION, goodCard, startFakeRegistry, startFakeTarget, type FakeTarget } from "./fakeTarget.js";

/**
 * End to end: the checkup service against a fake A2A target and a fake A2A Registry, with
 * the real OpenGlass API running in-process (same code as production, throwaway Mongo and
 * MinIO), and the worker's real record issuer. The checkup talks to OpenGlass only through
 * the published SDK and HTTP, the way any outside agent would.
 */

const CHECKUP_URL = "https://checkup.test";
const OPENGLASS_PUBLIC = "https://openglass.test";
const ADMIN = "admin-token-for-tests-0123";
const UNREGISTERED = "unregistered-agent.invalid";

let t: Awaited<ReturnType<typeof openTestDb>>;
let s3: Awaited<ReturnType<typeof openTestS3>>;
let apiDeps: ReturnType<typeof testServerDeps>;
let api: ReturnType<typeof buildApiServer>;
let apiUrl: string;
let link: OpenGlassLink;
let target: FakeTarget;
let registry: Awaited<ReturnType<typeof startFakeRegistry>>;
let checkup: ReturnType<typeof buildServer>;
let ownerId: string;

beforeAll(async () => {
  t = await openTestDb();
  await migrate(t.db, t.client);
  s3 = await openTestS3();
  apiDeps = { ...testServerDeps(t, { client: s3.client, bucket: s3.bucket }), publicUrl: OPENGLASS_PUBLIC };
  api = buildApiServer({ ...apiDeps, healthChecks: {} });
  await api.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;

  target = await startFakeTarget();
  registry = await startFakeRegistry([{ host: "listed.example", id: "reg-1", uptime: 99.5 }]);

  link = new OpenGlassLink({ apiUrl, publicUrl: OPENGLASS_PUBLIC, checkupUrl: CHECKUP_URL, privateKey: randomBytes(32) });
  checkup = buildServer({
    db: t.db,
    openglass: link,
    publicUrl: CHECKUP_URL,
    adminToken: ADMIN,
    registryUrl: registry.url,
    allowPrivateTargets: true,
  });
});

afterAll(async () => {
  await checkup?.close();
  await api?.close();
  await target?.close();
  await registry?.close();
  await s3?.cleanup();
  await t?.cleanup();
});

beforeEach(async () => {
  for (const c of ["checkup_reports", "checkup_events", "rate_limits"]) await t.db.collection(c).deleteMany({});
  target.requests.length = 0;
  target.set({ card: goodCard("{base}", { description: `Answers weather questions for any city. ${INJECTION}` }), rpc: "message" });
});

const basic = `Basic ${Buffer.from(`admin:${ADMIN}`).toString("base64")}`;

async function rpc(method: string, parts: unknown[], headers: Record<string, string> = {}) {
  const legacy = method === "message/send";
  const message = legacy ? { kind: "message", messageId: "m1", role: "user", parts } : { messageId: "m1", role: "ROLE_USER", parts };
  const res = await checkup.inject({
    method: "POST",
    url: "/a2a",
    headers: { "content-type": "application/json", ...headers },
    payload: { jsonrpc: "2.0", id: 7, method, params: { message } },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** The v1 (1.0) reply's text and JSON report. */
function partsOf(body: { result: { message?: { parts: Record<string, unknown>[] }; parts?: Record<string, unknown>[] } }) {
  const parts = body.result.message?.parts ?? body.result.parts ?? [];
  const text = parts.find((p) => typeof p.text === "string")?.text as string;
  const data = parts.find((p) => p.data)?.data as Record<string, any> | undefined;
  return { text, data };
}

describe("registration on OpenGlass", () => {
  it("registers the checkup agent, then finds it again by key after a restart", async () => {
    await link.init();
    expect(link.status).toBe("unclaimed");
    expect(link.claimUrl).toMatch(/\/claim\//);
    const agentId = link.agentId!;

    const owner = await insertTestOwner(t.db, "checkup-owner@example.com");
    ownerId = owner._id;
    await claimAgentDirectly(t.db, agentId, ownerId);

    const restarted = new OpenGlassLink({ ...link.opts });
    await restarted.init();
    expect(restarted.agentId).toBe(agentId);
    expect(restarted.status).toBe("active");
    await link.refreshStatus();
    expect(link.status).toBe("active");
  });
});

describe("agent card", () => {
  it("serves the same card at both well-known paths, valid under A2A 1.0 and 0.3", async () => {
    const current = await checkup.inject({ method: "GET", url: "/.well-known/agent-card.json" });
    const legacy = await checkup.inject({ method: "GET", url: "/.well-known/agent.json" });
    expect(current.json()).toEqual(legacy.json());
    expect(current.json()).toEqual(ownAgentCard(CHECKUP_URL, OPENGLASS_PUBLIC));
    expect(AgentCardV1.safeParse(current.json()).success).toBe(true);
    expect(AgentCardV03.safeParse(current.json()).success).toBe(true);
    expect(current.json().skills.map((s: { id: string }) => s.id)).toEqual(["check-agent"]);
  });
});

describe("a checkup over A2A", () => {
  it("checks a healthy agent: one benign message, nothing followed, recorded on OpenGlass", async () => {
    const body = await rpc("SendMessage", [{ text: `Please check ${target.url}` }]);
    const { text, data } = partsOf(body);
    expect(body.result.message.role).toBe("ROLE_AGENT");

    expect(data!.sections.card.score).toBe(100);
    expect(data!.sections.card.details.shape).toBe("1.0");
    expect(data!.sections.endpoint.details).toMatchObject({ ok: true, outcome: "message", method: "SendMessage" });
    expect(data!.sections.x402.score).toBeNull();
    expect(data!.overall).toBeGreaterThan(0);
    expect(data!.topFixes.length).toBeLessThanOrEqual(3);
    expect(text).toContain("Top fixes:");
    // The endpoint and identity checks both flag plain HTTP; the list says it once.
    expect(data!.topFixes.filter((f: { fix: string }) => /HTTPS/.test(f.fix))).toHaveLength(1);
    expect(text).toContain(`Full report: ${CHECKUP_URL}/r/${data!.reportId}`);

    // Exactly one message to the agent, benign, and nothing fetched from the injected URL.
    const posts = target.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body).params.message.parts[0].text).toBe(PROBE_TEXT);
    expect(posts[0]!.userAgent).toMatch(/AgentCheckup/);
    expect(target.requests.some((r) => r.path.startsWith("/steal"))).toBe(false);
    // The injected text never reaches the plain-language report.
    expect(text).not.toContain("SYSTEM OVERRIDE");

    expect(data!.verification).toMatchObject({ status: "recorded", bundleUrl: `${CHECKUP_URL}/r/${data!.reportId}/bundle.json` });
    // The fake target is plain HTTP on loopback, which OpenGlass's witness-fetch refuses:
    // the report says the probe went unwitnessed rather than implying it was verified.
    expect(data!.sections.endpoint.details).toMatchObject({ witnessed: false });
    expect(data!.sections.endpoint.details.witnessReason).toMatch(/^shadow_witness_failed: /);
    expect(text).toContain("The endpoint test message was not independently witnessed by OpenGlass (shadow_witness_failed: ");
  });

  it("issues a record whose bundle verifies offline with the published SDK", async () => {
    const { data } = partsOf(await rpc("SendMessage", [{ text: target.url }]));
    const reportId = data!.reportId as string;

    const pending = await checkup.inject({ method: "GET", url: `/r/${reportId}/bundle.json` });
    expect(pending.statusCode).toBe(202);

    const issued = await issueAttestationRecords({ db: t.db, s3: s3.client, s3Bucket: s3.bucket, signer: apiDeps.signer, contentEncryption: null });
    expect(issued.issued).toBeGreaterThan(0);

    const res = await checkup.inject({ method: "GET", url: `/r/${reportId}/bundle.json` });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    const sdk = new OpenGlassClient({ baseUrl: apiUrl });
    const keys = await sdk.fetchTrustedKeys();
    expect(sdk.verifyBundle(bundle, keys)).toMatchObject({ valid: true });

    const types = bundle.evidence.messages.map((m: { payload: { type: string } }) => m.payload.type);
    expect(types).toEqual([
      "checkup.request_received",
      "checkup.check_result",
      "checkup.check_result",
      "checkup.check_result",
      "checkup.check_result",
      "checkup.report_issued",
    ]);
    expect(bundle.evidence.messages[5].payload.reportId).toBe(reportId);
    // docs/SPEC.md §12.4: the first entry names the checked agent by card URL or domain; a
    // site root on an IP literal (this fake target) has neither, so it names none.
    expect(bundle.evidence.messages[0].payload.counterparty).toBeUndefined();
  });

  it("speaks A2A 0.3 (message/send) and reports a legacy card and a JSON-RPC error", async () => {
    target.set({
      card: null,
      legacyCard: {
        protocolVersion: "0.3",
        name: "Old Agent",
        description: "An agent from before A2A 1.0.",
        url: "{base}/rpc",
        version: "1",
        capabilities: {},
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        skills: [{ id: "s", name: "S", description: "Does one thing well enough.", tags: [] }],
      },
      rpc: "rpc-error",
    });
    const body = await rpc("message/send", [{ kind: "text", text: target.url }]);
    expect(body.result.kind).toBe("message");
    expect(body.result.role).toBe("agent");
    const { data } = partsOf(body);
    expect(data!.sections.card.details.shape).toBe("0.3");
    expect(data!.sections.card.findings.map((f: { fix: string }) => f.fix).join(" ")).toMatch(/supportedInterfaces/);
    expect(data!.sections.card.findings.map((f: { fix: string }) => f.fix).join(" ")).toMatch(/agent-card\.json/);
    expect(data!.sections.endpoint.details).toMatchObject({ method: "message/send", outcome: "rpc-error", rpcError: { code: -32601 } });
    // 40 for a reachable endpoint that answers with an error, minus 20 for plain HTTP.
    expect(data!.sections.endpoint.score).toBe(20);
    expect(JSON.parse(target.requests.find((r) => r.method === "POST")!.body).method).toBe("message/send");
  });

  it("lists missing and weak card fields", async () => {
    target.set({
      card: goodCard("{base}", { description: "Weather.", provider: undefined, skills: [{ id: "f", name: "F", description: "Forecast.", tags: [] }], version: undefined }),
      rpc: "message",
    });
    const { data } = partsOf(await rpc("SendMessage", [{ text: target.url }]));
    const card = data!.sections.card;
    expect(card.details.schemaErrors).toContainEqual({ path: "version", message: "is required" });
    const weak = card.details.weakFields.map((w: { path: string }) => w.path);
    expect(weak).toEqual(expect.arrayContaining(["description", "provider", "skills[0].description", "skills[0].examples", "skills[0].tags"]));
    expect(card.score).toBeLessThan(80);
  });

  it("checks x402: a well-formed 402 passes, a malformed one doesn't", async () => {
    const x402Card = goodCard("{base}", { capabilities: { extensions: [{ uri: "https://github.com/google-a2a/a2a-x402/v0.1", required: true }] } });
    target.set({ card: x402Card, rpc: "x402" });
    const good = partsOf(await rpc("SendMessage", [{ text: target.url }])).data!;
    expect(good.sections.x402).toMatchObject({ score: 100, details: { claimed: true, signal: "http-402", x402Version: 2, unpaidRequest: "endpoint-probe" } });
    expect(good.sections.endpoint.details.outcome).toBe("payment-required");

    await t.db.collection("checkup_reports").deleteMany({});
    target.set({ card: x402Card, rpc: "x402-malformed" });
    const bad = partsOf(await rpc("SendMessage", [{ text: target.url }])).data!;
    expect(bad.sections.x402.score).toBeLessThan(100);
    expect(bad.sections.x402.details.problems).toContain("accepts[0].network is missing");

    await t.db.collection("checkup_reports").deleteMany({});
    target.set({ card: x402Card, rpc: "message" });
    const unpaid = partsOf(await rpc("SendMessage", [{ text: target.url }])).data!;
    expect(unpaid.sections.x402.score).toBe(40);
  });

  it("replies with help, and runs nothing, when there's no target in the message", async () => {
    const { text, data } = partsOf(await rpc("SendMessage", [{ text: "hello, what can you do?" }]));
    expect(text).toMatch(/agent-card URL/);
    expect(data).toBeUndefined();
    expect(target.requests).toHaveLength(0);
  });

  it("answers JSON-RPC errors for bad requests and unsupported methods", async () => {
    const bad = await checkup.inject({ method: "POST", url: "/a2a", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(bad.json().error.code).toBe(-32700);
    const notRpc = await checkup.inject({ method: "POST", url: "/a2a", payload: { hello: 1 } });
    expect(notRpc.json().error.code).toBe(-32600);
    const stream = await checkup.inject({ method: "POST", url: "/a2a", payload: { jsonrpc: "2.0", id: 1, method: "message/stream", params: {} } });
    expect(stream.json().error.code).toBe(-32004);
    const unknown = await checkup.inject({ method: "POST", url: "/a2a", payload: { jsonrpc: "2.0", id: 1, method: "agent/selfDestruct" } });
    expect(unknown.json().error.code).toBe(-32601);
    const noParts = await checkup.inject({ method: "POST", url: "/a2a", payload: { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} } });
    expect(noParts.json().error.code).toBe(-32602);
  });
});

describe("caching and rate limits", () => {
  it("serves the same report for an hour without touching the target again", async () => {
    const first = partsOf(await rpc("SendMessage", [{ text: target.url }])).data!;
    const before = target.requests.length;
    const second = partsOf(await rpc("SendMessage", [{ text: `${target.url}/` }]));
    expect(second.data!.reportId).toBe(first.reportId);
    expect(second.data!.cached).toBe(true);
    expect(second.text).toContain("cached result");
    expect(target.requests.length).toBe(before);
  });

  it("limits fresh checks per caller and per target", async () => {
    const rateLimits = t.db.collection<{ _id: string; count: number; expiresAt: Date }>("rate_limits");
    const window = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const expiresAt = new Date(window + 3_600_000);

    const exhaust = (_id: string, count: number) => rateLimits.updateOne({ _id }, { $set: { count, expiresAt } }, { upsert: true });
    await exhaust(`checkup_target:127.0.0.1:${window}`, 6);
    const byTarget = partsOf(await rpc("SendMessage", [{ text: target.url }]));
    expect(byTarget.text).toMatch(/This target has had too many checkups/);
    expect(target.requests).toHaveLength(0);

    await exhaust(`checkup_caller:127.0.0.1:${window}`, 20);
    const byCaller = partsOf(await rpc("SendMessage", [{ text: "other.invalid" }]));
    expect(byCaller.text).toMatch(/You've run too many checkups/);
  });
});

describe("OpenGlass profile line", () => {
  it("lists an unregistered domain as an unclaimed profile, with a counted claim link", async () => {
    const { text, data } = partsOf(await rpc("SendMessage", [{ text: UNREGISTERED }]));
    const claimLink = `${CHECKUP_URL}/c/${data!.reportId}`;
    expect(text).toContain(`OpenGlass profile: unclaimed — claim it to add a verified domain: ${claimLink}`);
    expect(data!.openglass).toMatchObject({ status: "unclaimed", claimLink, claimUrl: `${OPENGLASS_PUBLIC}/agents/by-domain/${UNREGISTERED}#claim` });
    expect(data!.sections.identity.details.dns.resolves).toBe(false);
    // No card: the card section says so once; identity doesn't also ask for provider fields.
    expect(data!.topFixes.map((f: { fix: string }) => f.fix).join(" ")).not.toMatch(/provider/);

    const profile = await fetch(`${apiUrl}/v1/profiles/unclaimed/${UNREGISTERED}`).then((r) => r.json());
    expect(profile.profile).toMatchObject({ domain: UNREGISTERED, listedBy: link.agentId, claimed: false });

    const click = await checkup.inject({ method: "GET", url: `/c/${data!.reportId}` });
    expect(click.statusCode).toBe(302);
    expect(click.headers.location).toBe(data!.openglass.claimUrl);
  });

  it("says registered when an agent on OpenGlass claims the domain", async () => {
    const operator = testIdentity("op", "op_key");
    const body = { name: "Operator", description: "d", publicKey: operator.publicKey, meta: { homepage: "https://registered-agent.invalid" } };
    const headers = signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity: operator, selfSigned: true });
    const reg = await api.inject({ method: "POST", url: "/v1/agents", headers, payload: body });
    const agentId = reg.json().agent.id;

    const { text, data } = partsOf(await rpc("SendMessage", [{ text: "registered-agent.invalid" }]));
    expect(data!.openglass).toMatchObject({ status: "registered", agentId, domainVerified: false });
    expect(text).toContain(`OpenGlass profile: registered, domain not verified: ${OPENGLASS_PUBLIC}/agents/${agentId}`);
  });
});

describe("web pages and metrics", () => {
  it("runs a checkup from the form and renders the report with links", async () => {
    const res = await checkup.inject({ method: "GET", url: `/check?target=${encodeURIComponent(target.url)}` });
    expect(res.statusCode).toBe(303);
    const page = await checkup.inject({ method: "GET", url: res.headers.location as string });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Top fixes");
    expect(page.body).toContain("The endpoint test message was not independently witnessed by OpenGlass");
    expect(page.body).not.toContain("<script");
    // Target text is escaped, never rendered as markup.
    expect(page.body).not.toContain(INJECTION.replace("{base}", target.url));

    const json = await checkup.inject({ method: "GET", url: `${res.headers.location}.json` });
    expect(json.json().type).toBe("openglass.checkup.report");
    expect((await checkup.inject({ method: "GET", url: "/r/chk_01J8Z3K4M5N6P7Q8R9S0T1V2W3" })).statusCode).toBe(404);
  });

  it("counts registry probes separately, report opens, claim clicks and registrations from claims", async () => {
    await rpc("SendMessage", [{ text: "hello" }], { "user-agent": "A2A-Registry-Smoke/1.0" });
    await rpc("SendMessage", [{ text: "hello" }], { "user-agent": "A2A-Registry-TaskProbe/1.0" });
    const { data } = partsOf(await rpc("SendMessage", [{ text: UNREGISTERED }]));
    await checkup.inject({ method: "GET", url: `/r/${data!.reportId}` });
    await checkup.inject({ method: "GET", url: `/c/${data!.reportId}` });

    // The domain's operator registers, gets claimed and verifies the domain: that claims the profile.
    const operator = testIdentity("op2", "op2_key");
    const body = { name: "Operator 2", description: "d", publicKey: operator.publicKey, meta: { homepage: `https://${UNREGISTERED}` } };
    const reg = await api.inject({ method: "POST", url: "/v1/agents", headers: signedRequestHeaders({ method: "POST", path: "/v1/agents", body, identity: operator, selfSigned: true }), payload: body });
    operator.agentId = reg.json().agent.id;
    operator.kid = reg.json().agent.keys[0].kid;
    await claimAgentDirectly(t.db, operator.agentId, ownerId);
    const verifying = buildApiServer({ ...apiDeps, healthChecks: {}, checkDomainVerification: async () => true });
    for (const path of ["/v1/agents/me/domain-verification", "/v1/agents/me/domain-verification/check"]) {
      const r = await verifying.inject({ method: "POST", url: path, headers: signedRequestHeaders({ method: "POST", path, identity: operator }) });
      expect(r.statusCode).toBeLessThan(300);
    }

    expect((await checkup.inject({ method: "GET", url: "/admin" })).statusCode).toBe(401);
    const admin = await checkup.inject({ method: "GET", url: "/admin", headers: { authorization: basic } });
    expect(admin.statusCode).toBe(200);
    const row = (label: string) => new RegExp(`<tr><td>${label}</td><td>(\\d+)</td>`).exec(admin.body)?.[1];
    expect(row("Checks run")).toBe("1");
    expect(row("A2A Registry probes")).toBe("2");
    expect(row("Unique targets")).toBe("1");
    expect(row("Report-link opens")).toBe("1");
    expect(row("Claim-link clicks")).toBe("1");
    expect(admin.body).toMatch(new RegExp(`Registrations from claims</td><td colspan="4">1 \\(${UNREGISTERED.replace(".", "\\.")}\\)`));
    expect(admin.body).toContain("Registered and claimed");
  });

  it("serves its own fonts and tokens (no third-party requests)", async () => {
    const landing = await checkup.inject({ method: "GET", url: "/" });
    expect(landing.body).not.toMatch(/https:\/\/fonts\.|googleapis|cdn/);
    expect((await checkup.inject({ method: "GET", url: "/assets/tokens.css" })).body).toContain("--accent");
    const font = await checkup.inject({ method: "GET", url: "/assets/fonts/manrope-latin-400-normal.woff2" });
    expect(font.statusCode).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect((await checkup.inject({ method: "GET", url: "/assets/fonts/..%2F..%2Fpackage.json" })).statusCode).toBe(404);
  });
});
