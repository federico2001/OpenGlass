import { describe, expect, it } from "vitest";
import type { OwnerAttestation, OwnerSession } from "../lib/dashboard";
import {
  attestationCounterparty,
  buildTimeline,
  countDirections,
  counterpartyFromPayload,
  counterpartyHref,
  describeEvent,
  humanizeType,
  messageDirection,
  plainCloseReason,
  plainStatus,
  sessionPerspective,
} from "../lib/interactions";

const ME = "own_me";
const THEM = "own_them";
const MINE = "agt_mine";
const OTHER = "agt_other";

function session(over: Partial<OwnerSession> = {}): OwnerSession {
  return {
    id: "ses_1",
    mode: "relay",
    status: "closed",
    purpose: "Negotiate delivery",
    initiator: { agentId: MINE, ownerId: ME, kid: "k1" },
    counterparty: { agentId: OTHER, ownerId: THEM, kid: "k2" },
    head: { seq: 3, hash: "a".repeat(64) },
    messageCount: 3,
    createdAt: "2026-10-01T10:00:00.000Z",
    activatedAt: "2026-10-01T10:00:01.000Z",
    closedAt: "2026-10-01T10:05:00.000Z",
    recordId: "rec_1",
    pause: null,
    ...over,
  };
}

const msg = (sender: string) => ({ envelope: { sender: { agentId: sender, kid: "k" }, contentType: "application/json", payloadHash: "h", sentAt: "" } });

describe("sessionPerspective / messageDirection", () => {
  it("puts the viewer's agent first whichever side it was on", () => {
    expect(sessionPerspective(session(), { ownerId: ME })).toMatchObject({ mine: "initiator", myAgentId: MINE, otherAgentId: OTHER });
    expect(sessionPerspective(session(), { ownerId: THEM })).toMatchObject({ mine: "counterparty", myAgentId: OTHER, otherAgentId: MINE });
    expect(sessionPerspective(session(), { agentIds: [OTHER] })).toMatchObject({ mine: "counterparty", myAgentId: OTHER });
  });

  it("labels each message sent or received from the viewer's side, and neutral for a read-only viewer", () => {
    const mine = sessionPerspective(session(), { ownerId: ME });
    expect(messageDirection(MINE, mine)).toBe("sent");
    expect(messageDirection(OTHER, mine)).toBe("received");
    const theirs = sessionPerspective(session(), { ownerId: THEM });
    expect(messageDirection(MINE, theirs)).toBe("received");
    const viewer = sessionPerspective(session(), { ownerId: "own_viewer" });
    expect(viewer.mine).toBeNull();
    expect(messageDirection(MINE, viewer)).toBe("neutral");
    expect(countDirections([msg(MINE), msg(OTHER), msg(MINE)], mine)).toEqual({ sent: 2, received: 1 });
  });

  it("handles both agents being the viewer's", () => {
    const p = sessionPerspective(session({ counterparty: { agentId: OTHER, ownerId: ME, kid: "k2" } }), { ownerId: ME });
    expect(p).toMatchObject({ mine: "initiator", bothMine: true, myAgentId: MINE });
    expect(messageDirection(OTHER, p)).toBe("received");
  });
});

describe("plain wording", () => {
  it("describes statuses and close reasons in words", () => {
    expect(plainStatus("session", "pending")).toBe("Waiting for the other agent to accept");
    expect(plainStatus("attestation", "closed")).toBe("Finished");
    expect(plainStatus("session", "something_new")).toBe("something_new");
    expect(plainCloseReason("idle_timeout")).toMatch(/no activity/);
    expect(plainCloseReason("brand_new_reason")).toBe("brand new reason");
  });

  it("humanizes event types", () => {
    expect(humanizeType("checkup.check_result")).toBe("Check result");
    expect(humanizeType("payment_sent")).toBe("Payment sent");
    expect(humanizeType("toolCall")).toBe("Tool call");
  });
});

describe("describeEvent", () => {
  it("summarizes Agent Checkup entries", () => {
    expect(describeEvent({ payload: { type: "checkup.request_received", target: { cardUrl: "https://a.example/card.json" } } })).toEqual({
      title: "Checkup requested",
      summary: "Asked to check the agent at https://a.example/card.json",
    });
    expect(describeEvent({ payload: { type: "checkup.check_result", section: "card", score: 80, summary: "Mostly fine" } })).toEqual({
      title: "Checked the card",
      summary: "score 80: Mostly fine",
    });
    expect(describeEvent({ payload: { type: "checkup.report_issued", overall: 72 } })).toEqual({ title: "Report issued", summary: "Overall score 72" });
  });

  it("summarizes openglass-policy verdicts, typed entries, text, and Notary entries", () => {
    expect(describeEvent({ payload: { event: {}, verdict: { risk: "high", matches: [{ id: "financial-transaction" }] } } })).toEqual({
      title: "Action checked against its policy: high risk",
      summary: "Matched financial-transaction",
    });
    expect(describeEvent({ payload: { type: "refund.issued", text: "Refunded $20" } })).toEqual({ title: "Issued", summary: "Refunded $20" });
    expect(describeEvent({ payload: { text: "hello" } })).toEqual({ title: "Message", summary: "hello" });
    expect(describeEvent({ payload: "plain note" })).toEqual({ title: "Note", summary: "plain note" });
    expect(describeEvent({ payload: { a: 1 } })).toEqual({ title: "Entry", summary: null });
    expect(describeEvent({}).summary).toMatch(/Notary mode/);
    expect(describeEvent({ payload: { text: "x".repeat(500) } }).summary!.length).toBeLessThanOrEqual(160);
  });
});

describe("counterparty of an attestation", () => {
  it("reads an explicit counterparty, a policy counterpartyCheck, or a checkup target", () => {
    expect(counterpartyFromPayload({ counterparty: { agentId: "agt_x" } })).toEqual({ kind: "agent", agentId: "agt_x" });
    expect(counterpartyFromPayload({ counterparty: { agentCardUrl: "https://Bot.Acme.example/.well-known/agent-card.json" } })).toEqual({
      kind: "domain",
      domain: "bot.acme.example",
      agentCardUrl: "https://Bot.Acme.example/.well-known/agent-card.json",
    });
    expect(counterpartyFromPayload({ counterparty: { domain: "Acme.example" } })).toEqual({ kind: "domain", domain: "acme.example", agentCardUrl: null });
    expect(counterpartyFromPayload({ counterpartyCheck: { lookup: { registered: true, agentId: "agt_y" } } })).toEqual({ kind: "agent", agentId: "agt_y" });
    expect(counterpartyFromPayload({ type: "checkup.request_received", target: { origin: "https://acme.example", cardUrl: null } })).toEqual({
      kind: "domain",
      domain: "acme.example",
      agentCardUrl: null,
    });
    expect(counterpartyFromPayload({ text: "nothing here" })).toBeNull();
    expect(counterpartyFromPayload(undefined)).toBeNull();
  });

  it("takes the first entry that names one, and links to the dashboard profile", () => {
    const ref = attestationCounterparty([{ payload: { a: 1 } }, { payload: { counterparty: { domain: "b.example" } } }, { payload: { counterparty: { agentId: "agt_z" } } }]);
    expect(ref).toEqual({ kind: "domain", domain: "b.example", agentCardUrl: null });
    expect(counterpartyHref(ref!)).toBe("/dashboard/counterparties/by-domain/b.example");
    expect(counterpartyHref({ kind: "agent", agentId: "agt_z" })).toBe("/dashboard/counterparties/agt_z");
  });
});

describe("buildTimeline", () => {
  it("merges sessions and attestations newest first, from the viewer's side", () => {
    const attestation: OwnerAttestation = {
      id: "att_1",
      mode: "relay",
      status: "closed",
      purpose: "financial-transaction",
      attestor: { agentId: MINE, ownerId: ME, kid: "k1" },
      eventCount: 2,
      createdAt: "2026-10-02T10:00:00.000Z",
      activatedAt: "2026-10-02T10:00:00.000Z",
      closedAt: null,
      recordId: null,
    };
    const items = buildTimeline([session({ initiator: { agentId: OTHER, ownerId: THEM, kid: "k" }, counterparty: { agentId: MINE, ownerId: ME, kid: "k" } })], [attestation], {
      ownerId: ME,
    });
    expect(items.map((i) => [i.kind, i.myAgentId, i.otherAgentId, i.count, i.flagged])).toEqual([
      ["attestation", MINE, null, 2, true],
      ["session", MINE, OTHER, 3, false],
    ]);
    expect(items[1]!.href).toBe("/dashboard/sessions/ses_1");
    expect(items[1]!.recordIssued).toBe(true);
  });
});
