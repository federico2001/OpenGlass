import { agents, invites, messages, records, sessions, type AgentDoc, type InviteDoc, type MessageDoc, type RecordDoc, type SessionDoc } from "@openglass/db";
import type { ChangeStream, ChangeStreamDocument, Db } from "mongodb";
import type { WebSocket } from "ws";
import { agentFullView } from "../domain/agentViews.js";
import { messageView } from "../domain/messageViews.js";
import { inviteView, sessionView } from "../domain/sessionViews.js";

type ServerFrame = Record<string, unknown> & { type: string };

const SESSION_EVENT_STATUSES = new Set(["active", "declined", "cancelled", "expired", "closing", "paused"]);

function send(socket: WebSocket, frame: ServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

/** Delivers to the union of several connection sets, each socket at most once even if it
 * appears in more than one (e.g. a participant agent who also explicitly subscribed). */
function deliverUnion(sets: (Set<WebSocket> | undefined)[], frame: ServerFrame): void {
  const seen = new Set<WebSocket>();
  for (const set of sets) {
    if (!set) continue;
    for (const socket of set) {
      if (seen.has(socket)) continue;
      seen.add(socket);
      send(socket, frame);
    }
  }
}

/**
 * SPEC §9's live-relay fan-out. `api` and `worker` are separate processes — the worker
 * closes idle/suspended sessions and issues records — so the only reliable way for this
 * process to learn about a change, whichever process made it, is to watch MongoDB itself.
 * One change stream per collection, opened only while at least one WS connection is live
 * (ref-counted by identify/removeConnection) so the hundreds of `buildServer()` calls
 * across the test suite that never open a WS connection never hold a cursor open.
 *
 * Delivery is intentionally best-effort and in-memory only (no resume token persisted
 * across restarts) — SPEC §9 is explicit that "the WebSocket isn't needed for delivery
 * guarantees: clients resync with afterSeq".
 */
export function createWsHub(db: Db) {
  const sessionSubs = new Map<string, Set<WebSocket>>();
  const agentConns = new Map<string, Set<WebSocket>>();
  const ownerConns = new Map<string, Set<WebSocket>>();
  const socketMeta = new Map<WebSocket, { kind: "agent" | "owner"; id: string; sessions: Set<string> }>();

  let liveConnections = 0;
  let streams: ChangeStream[] = [];

  function sessionEventTargets(session: Pick<SessionDoc, "_id" | "initiator" | "counterparty">): (Set<WebSocket> | undefined)[] {
    return [
      session.initiator.agentId ? agentConns.get(session.initiator.agentId) : undefined,
      session.counterparty.agentId ? agentConns.get(session.counterparty.agentId) : undefined,
      sessionSubs.get(session._id),
    ];
  }

  async function handleSessionsChange(change: ChangeStreamDocument<SessionDoc>): Promise<void> {
    if (change.operationType !== "update" && change.operationType !== "replace") return;
    const doc = "fullDocument" in change ? change.fullDocument : undefined;
    if (!doc) return;
    const updatedFields = change.operationType === "update" ? change.updateDescription?.updatedFields : undefined;
    if (change.operationType === "update" && !updatedFields?.status) return;
    if (!SESSION_EVENT_STATUSES.has(doc.status)) return;
    deliverUnion(sessionEventTargets(doc), { type: `session.${doc.status}`, session: sessionView(doc) });
  }

  function handleMessagesChange(change: ChangeStreamDocument<MessageDoc>): void {
    if (change.operationType !== "insert") return;
    const doc = change.fullDocument;
    deliverUnion([sessionSubs.get(doc.sessionId)], { type: "message", sessionId: doc.sessionId, message: messageView(doc) });
  }

  async function handleInvitesChange(change: ChangeStreamDocument<InviteDoc>): Promise<void> {
    if (change.operationType === "insert") {
      const doc = change.fullDocument;
      if (doc.kind === "direct" && doc.toAgentId) {
        deliverUnion([agentConns.get(doc.toAgentId)], { type: "invite.received", invite: inviteView(doc) });
      }
      return;
    }
    if (change.operationType !== "update") return;
    if (change.updateDescription?.updatedFields?.status !== "awaiting_owner") return;
    const doc = change.fullDocument;
    if (!doc) return;
    const session = await db.collection<SessionDoc>(sessions.name).findOne({ _id: doc.sessionId });
    const ownerId = session?.counterparty.ownerId;
    if (ownerId) deliverUnion([ownerConns.get(ownerId)], { type: "invite.awaiting_owner", invite: inviteView(doc) });
  }

  function handleRecordsChange(change: ChangeStreamDocument<RecordDoc>): void {
    if (change.operationType !== "insert") return;
    const doc = change.fullDocument;
    const targets = [...doc.participantAgentIds.map((id) => agentConns.get(id)), sessionSubs.get(doc.sessionId)];
    deliverUnion(targets, { type: "record.issued", sessionId: doc.sessionId, recordId: doc._id });
  }

  function handleAgentsChange(change: ChangeStreamDocument<AgentDoc>): void {
    if (change.operationType !== "update") return;
    const updatedFields = change.updateDescription?.updatedFields;
    // A genuine claim sets both status:"active" and claimedAt together; unsuspend only
    // touches status (and suspendedAt), so this can't fire spuriously for that.
    if (updatedFields?.status !== "active" || !updatedFields?.claimedAt) return;
    const doc = change.fullDocument;
    if (!doc) return;
    deliverUnion([agentConns.get(doc._id)], { type: "agent.claimed", agent: agentFullView(doc) });
  }

  function start(): void {
    if (streams.length) return;
    function open<T extends { _id: string }>(name: string, handler: (change: ChangeStreamDocument<T>) => void | Promise<void>): ChangeStream {
      const stream = db.collection<T>(name).watch([], { fullDocument: "updateLookup" });
      stream.on("change", (change) => {
        Promise.resolve(handler(change)).catch((err) => {
          // Best-effort delivery (SPEC §9) — a single bad event never tears down the hub.
          console.error(`[ws] error handling ${name} change stream event`, err);
        });
      });
      stream.on("error", (err) => console.error(`[ws] ${name} change stream error`, err));
      return stream;
    }
    streams = [
      open<SessionDoc>(sessions.name, handleSessionsChange),
      open<MessageDoc>(messages.name, handleMessagesChange),
      open<InviteDoc>(invites.name, handleInvitesChange),
      open<RecordDoc>(records.name, handleRecordsChange),
      open<AgentDoc>(agents.name, handleAgentsChange),
    ];
  }

  async function stop(): Promise<void> {
    const closing = streams;
    streams = [];
    await Promise.all(closing.map((s) => s.close().catch(() => {})));
  }

  return {
    identifyAgent(socket: WebSocket, agentId: string): void {
      liveConnections++;
      if (liveConnections === 1) start();
      let set = agentConns.get(agentId);
      if (!set) agentConns.set(agentId, (set = new Set()));
      set.add(socket);
      socketMeta.set(socket, { kind: "agent", id: agentId, sessions: new Set() });
    },
    identifyOwner(socket: WebSocket, ownerId: string): void {
      liveConnections++;
      if (liveConnections === 1) start();
      let set = ownerConns.get(ownerId);
      if (!set) ownerConns.set(ownerId, (set = new Set()));
      set.add(socket);
      socketMeta.set(socket, { kind: "owner", id: ownerId, sessions: new Set() });
    },
    subscribe(socket: WebSocket, sessionId: string): void {
      let set = sessionSubs.get(sessionId);
      if (!set) sessionSubs.set(sessionId, (set = new Set()));
      set.add(socket);
      socketMeta.get(socket)?.sessions.add(sessionId);
    },
    unsubscribe(socket: WebSocket, sessionId: string): void {
      sessionSubs.get(sessionId)?.delete(socket);
      socketMeta.get(socket)?.sessions.delete(sessionId);
    },
    removeConnection(socket: WebSocket): void {
      const meta = socketMeta.get(socket);
      if (!meta) return;
      (meta.kind === "agent" ? agentConns : ownerConns).get(meta.id)?.delete(socket);
      for (const sessionId of meta.sessions) sessionSubs.get(sessionId)?.delete(socket);
      socketMeta.delete(socket);
      liveConnections = Math.max(0, liveConnections - 1);
      if (liveConnections === 0) void stop();
    },
    /** Graceful shutdown hook (`onClose`) — closes any open change streams regardless of
     * the ref count, e.g. sockets that never sent a clean close frame in tests. */
    close: stop,
  };
}

export type WsHub = ReturnType<typeof createWsHub>;
