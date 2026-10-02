import { connect } from "@openglass/db";
import { base64UrlDecode } from "openglass-sdk";
import { loadConfig } from "./config.js";
import { OpenGlassLink } from "./openglass.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const { db, close } = await connect(config.MONGODB_URI, "openglass-checkup");

const openglass = new OpenGlassLink({
  apiUrl: config.OPENGLASS_API_URL,
  publicUrl: config.OPENGLASS_PUBLIC_URL,
  checkupUrl: config.CHECKUP_PUBLIC_URL,
  privateKey: new Uint8Array(base64UrlDecode(config.CHECKUP_AGENT_PRIVATE_KEY)),
});

const app = buildServer({
  db,
  openglass,
  publicUrl: config.CHECKUP_PUBLIC_URL,
  adminToken: config.CHECKUP_ADMIN_TOKEN,
  registryUrl: config.A2A_REGISTRY_URL,
  allowPrivateTargets: config.CHECKUP_ALLOW_PRIVATE_TARGETS,
  logger: { level: config.LOG_LEVEL },
});

await app.listen({ host: "0.0.0.0", port: config.PORT });

// Register (or find) the checkup agent on OpenGlass, then keep checking until its owner has
// claimed it. Checkups run either way; they're recorded only once it's claimed.
async function syncAgent(): Promise<void> {
  if (openglass.status === "unregistered" || openglass.status === "error") await openglass.init();
  else await openglass.refreshStatus();
  if (openglass.status === "unclaimed" && openglass.claimUrl) {
    app.log.warn({ agentId: openglass.agentId, claimUrl: openglass.claimUrl }, "checkup agent is not claimed yet; open the claim link signed in as its owner");
  } else if (openglass.status === "error") {
    app.log.warn({ error: openglass.lastError }, "could not reach OpenGlass; checkups are not recorded until it can");
  }
}
await syncAgent();
const timer = setInterval(() => {
  if (openglass.status !== "active") void syncAgent();
}, 60_000);
timer.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    clearInterval(timer);
    await app.close();
    await close();
    process.exit(0);
  });
}
