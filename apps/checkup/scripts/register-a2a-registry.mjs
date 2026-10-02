#!/usr/bin/env node
// Registers Agent Checkup with the A2A Registry, then waits until the registry reports it
// reachable (is_healthy) and task-verified (its message/send probe passed).
//
//   node apps/checkup/scripts/register-a2a-registry.mjs [https://checkup.openglass.glass]
//
// Env: A2A_REGISTRY_URL (default https://a2aregistry.org), WAIT_MINUTES (default 40; the
// registry re-checks agents every 30 minutes), REGISTER_TIMEOUT_SECONDS (default 120; the
// registry fetches the card and may probe message/send before it answers the registration).

const checkupUrl = (process.argv[2] ?? "https://checkup.openglass.glass").replace(/\/+$/, "");
const registry = (process.env.A2A_REGISTRY_URL ?? "https://a2aregistry.org").replace(/\/+$/, "");
const waitMinutes = Number(process.env.WAIT_MINUTES ?? 40);
const registerTimeoutMs = Number(process.env.REGISTER_TIMEOUT_SECONDS ?? 120) * 1000;
const wellKnownURI = `${checkupUrl}/.well-known/agent-card.json`;
const host = new URL(checkupUrl).hostname;

async function json(url, init, timeoutMs = 30_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// 0. Our own card must be up first; the registry fetches it on registration.
const card = await json(wellKnownURI);
if (card.status !== 200) {
  console.error(`${wellKnownURI} returned ${card.status}; deploy the checkup first.`);
  process.exit(1);
}
console.log(`card ok: ${card.body.name}`);

const isTimeout = (err) => err?.name === "TimeoutError";

// 1. Register (idempotent from our side: a duplicate is reported and we move on). A timeout
// doesn't mean it failed: the registry may still finish on its side, so we go on to polling.
try {
  const reg = await json(
    `${registry}/api/agents/register`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wellKnownURI }) },
    registerTimeoutMs,
  );
  console.log(`register: HTTP ${reg.status}`, JSON.stringify(reg.body));
  if (reg.status >= 400 && reg.status !== 409) process.exit(1);
} catch (err) {
  if (!isTimeout(err)) throw err;
  console.log(`register: no response within ${registerTimeoutMs / 1000}s; checking whether it landed`);
}

// 2. Wait for reachable + task-verified.
const deadline = Date.now() + waitMinutes * 60_000;
for (;;) {
  try {
    if (await checkListing()) process.exit(0);
  } catch (err) {
    if (!isTimeout(err)) throw err;
    console.log("registry timed out; retrying in a minute");
  }
  if (Date.now() > deadline) {
    console.error(`gave up after ${waitMinutes} minutes`);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 60_000));
}

/** True once the registry lists the checkup as reachable and task-verified. */
async function checkListing() {
  const list = await json(`${registry}/api/agents?search=${encodeURIComponent(host)}&limit=50`);
  const items = Array.isArray(list.body) ? list.body : (list.body?.agents ?? list.body?.items ?? list.body?.data ?? []);
  const agent = items.find((a) => [a.wellKnownURI, a.well_known_uri, a.url].some((u) => typeof u === "string" && u.includes(host)));
  if (agent) {
    const id = agent.id ?? agent.agent_id;
    const [health, uptime] = await Promise.all([json(`${registry}/api/agents/${id}/health`), json(`${registry}/api/agents/${id}/uptime`)]);
    const category = String(agent.task_conformance?.category ?? "").toUpperCase();
    const reachable = agent.is_healthy === true || health.body?.is_healthy === true;
    const taskVerified = agent.task_verified === true || category === "WORKING";
    console.log(
      JSON.stringify({ id, reachable, taskVerified, conformance: agent.conformance, task_conformance: agent.task_conformance, health: health.body, uptime: uptime.body }),
    );
    if (reachable && taskVerified) {
      console.log(`listed: ${registry}/agents/${id}/ (reachable, task-verified)`);
      return true;
    }
  } else {
    console.log("not listed yet");
  }
  return false;
}
