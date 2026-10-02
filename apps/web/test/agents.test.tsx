import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentProfile, UnclaimedProfileSection } from "../components/AgentProfile";
import { GET as getAgentJson } from "../app/agents/[id]/agent.json/route";

// renderToStaticMarkup never runs effects (SSR doesn't execute useEffect), so these never
// make a real network call — they only exercise the initial-render / loading-state path,
// the same scope home.test.tsx/legal.test.tsx already cover for other client components.
describe("AgentProfile (realignment R3, docs/SPEC.md §14)", () => {
  it("renders the loading state without throwing, for either query shape", () => {
    expect(renderToStaticMarkup(<AgentProfile query={{ agentId: "agt_probe" }} />)).toContain("Looking up");
    expect(renderToStaticMarkup(<AgentProfile query={{ domain: "acme.example" }} />)).toContain("Looking up");
  });
});

describe("UnclaimedProfileSection (docs/SPEC.md §16)", () => {
  it("shows only platform-held facts and the claim steps, anchored at #claim", () => {
    const html = renderToStaticMarkup(
      <UnclaimedProfileSection
        profile={{
          domain: "acme.example",
          agentCardUrl: "https://acme.example/.well-known/agent-card.json",
          cardSha256: "a".repeat(64),
          cardFetchedAt: "2026-10-02T00:00:00.000Z",
          listedBy: "agt_x",
          listedAt: "2026-10-02T00:00:00.000Z",
          lastSeenAt: "2026-10-02T00:00:00.000Z",
          claimed: false,
          claimedAgentId: null,
          claimedAt: null,
          profileUrl: "https://openglass.glass/agents/by-domain/acme.example",
          claimUrl: "https://openglass.glass/agents/by-domain/acme.example#claim",
        }}
      />,
    );
    expect(html).toContain('id="claim"');
    expect(html).toContain("https://acme.example/.well-known/agent-card.json");
    expect(html).toContain("verify the domain");
  });
});

describe("GET /agents/{id}/agent.json (realignment R3)", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("proxies apps/api's GET /v1/agents/{id}/agent.json over the internal Docker network", async () => {
    process.env.API_INTERNAL_URL = "http://api-test:3000";
    const card = { name: "Acme Bot", "x-openglass": { agentId: "agt_probe" } };
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://api-test:3000/v1/agents/agt_probe/agent.json");
      return new Response(JSON.stringify(card), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getAgentJson(new Request("https://web.example/agents/agt_probe/agent.json"), { params: Promise.resolve({ id: "agt_probe" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(card);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("passes through a non-200 status (e.g. not_found) from the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 })));
    const res = await getAgentJson(new Request("https://web.example/agents/agt_missing/agent.json"), { params: Promise.resolve({ id: "agt_missing" }) });
    expect(res.status).toBe(404);
  });
});
