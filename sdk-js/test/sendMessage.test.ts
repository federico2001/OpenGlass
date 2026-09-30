// sendMessage chain handling (docs/SPEC.md §5.3, D8), against a scripted fetch. Two
// agents talking means the head moves between your sends; sendMessage must read the head
// when it doesn't know it, and re-chain + retry on 409 chain_conflict — otherwise a
// normal back-and-forth fails on its second turn.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenGlassApiError, OpenGlassClient, canonicalize, hex, sha256 } from "../src/index.js";

const SESSION = "ses_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
const GENESIS = "a".repeat(64);
const H2 = "b".repeat(64);

type Body = { envelope: { seq: number; prevHash: string }; hash: string; payload: unknown };

function client() {
  const identity = OpenGlassClient.generateIdentity();
  identity.agentId = "agt_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
  identity.kid = "key_01J8Z3K4M5N6P7Q8R9S0T1V2W3";
  return new OpenGlassClient({ baseUrl: "https://og.test", identity });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const activeSession = json(200, { session: { status: "active", genesisHash: GENESIS, head: { seq: 0, hash: null } } });
const conflict = (seq: number, hash: string) => json(409, { error: { code: "chain_conflict", message: "Head has moved", details: { head: { seq, hash } } } });

function accept(body: Body) {
  const expected = hex(sha256(Buffer.concat([Buffer.from(body.envelope.prevHash, "hex"), Buffer.from(canonicalize(body.envelope), "utf8")])));
  expect(body.hash).toBe(expected);
  return json(201, { message: { seq: body.envelope.seq }, head: { seq: body.envelope.seq, hash: body.hash } });
}

function stubFetch(onPost: (body: Body, n: number) => Response, onGet: () => Response = () => activeSession.clone()) {
  const posts: Body[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "GET") return onGet();
    const body = JSON.parse(init.body as string) as Body;
    posts.push(body);
    return onPost(body, posts.length);
  });
  return posts;
}

afterEach(() => vi.unstubAllGlobals());

describe("sendMessage chain handling", () => {
  it("reads the head from the session when it has none", async () => {
    const posts = stubFetch((b) => accept(b));
    await client().sendMessage(SESSION, { offer: 1 });
    expect(posts.map((p) => [p.envelope.seq, p.envelope.prevHash])).toEqual([[1, GENESIS]]);
  });

  it("re-chains onto the server's head after a chain_conflict", async () => {
    const posts = stubFetch((b, n) => (n === 1 ? conflict(2, H2) : accept(b)));
    const result = await client().sendMessage(SESSION, { accept: true });
    expect(posts.map((p) => [p.envelope.seq, p.envelope.prevHash])).toEqual([[1, GENESIS], [3, H2]]);
    expect(result.head.seq).toBe(3);
    expect(posts[1]!.payload).toEqual(posts[0]!.payload);
  });

  it("gives up after retryOnConflict attempts", async () => {
    const posts = stubFetch((_b, n) => conflict(n, H2));
    await expect(client().sendMessage(SESSION, { x: 1 }, { retryOnConflict: 2 })).rejects.toBeInstanceOf(OpenGlassApiError);
    expect(posts).toHaveLength(3);
  });

  it("never retries explicit seq/prevHash", async () => {
    const posts = stubFetch(() => conflict(5, H2));
    await expect(client().sendMessage(SESSION, { x: 1 }, { seq: 1, prevHash: GENESIS })).rejects.toBeInstanceOf(OpenGlassApiError);
    expect(posts).toHaveLength(1);
  });

  it("doesn't retry other errors", async () => {
    const posts = stubFetch(() => json(409, { error: { code: "session_not_active", message: "closed" } }));
    await expect(client().sendMessage(SESSION, { x: 1 })).rejects.toBeInstanceOf(OpenGlassApiError);
    expect(posts).toHaveLength(1);
  });

  it("explains what to wait for on a pending session", async () => {
    stubFetch(() => json(500, {}), () => json(200, { session: { status: "pending", genesisHash: null, head: { seq: 0, hash: null } } }));
    await expect(client().sendMessage(SESSION, { x: 1 })).rejects.toThrow(/waitForActive/);
  });
});
