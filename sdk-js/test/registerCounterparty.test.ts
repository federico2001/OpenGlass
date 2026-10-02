// registerCounterparty (docs/SPEC.md §16), against a stubbed fetch: it signs a POST to
// /v1/profiles/unclaimed with exactly the body it was given, and surfaces
// already_registered as an OpenGlassApiError carrying the registered agent's id.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenGlassApiError, OpenGlassClient } from "../src/index.js";

function client() {
  const identity = OpenGlassClient.generateIdentity();
  identity.agentId = "agt_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
  identity.kid = "key_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
  return new OpenGlassClient({ baseUrl: "https://og.test", identity });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("registerCounterparty", () => {
  it("posts the agent card URL, signed, and returns the profile", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(201, { profile: { domain: "acme.example", claimed: false } });
    });
    const profile = await client().registerCounterparty({ agentCardUrl: "https://acme.example/.well-known/agent-card.json" });
    expect(profile).toMatchObject({ domain: "acme.example", claimed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://og.test/v1/profiles/unclaimed");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ agentCardUrl: "https://acme.example/.well-known/agent-card.json" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["og-agent"]).toBe("agt_01J8Z3K4M5N6P7Q8R9S0T1V2W3");
    expect(headers["og-signature"]).toBeTruthy();
  });

  it("throws already_registered with the registered agent's id", async () => {
    vi.stubGlobal("fetch", async () => json(409, { error: { code: "already_registered", message: "taken", details: { agentId: "agt_X" } } }));
    const err = await client()
      .registerCounterparty({ agentCard: { name: "Acme", url: "https://acme.example/a2a" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenGlassApiError);
    expect((err as OpenGlassApiError).status).toBe(409);
  });
});
