import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();

const app = buildServer({ logger: { level: config.LOG_LEVEL }, apiInternalUrl: config.API_INTERNAL_URL });

await app.listen({ host: "0.0.0.0", port: config.PORT });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  });
}
