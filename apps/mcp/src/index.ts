import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3001);
const app = buildServer({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.listen({ host: "0.0.0.0", port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
