import { connectFromEnv } from "@openglass/db";
import { buildHealthServer } from "./health.js";

// Background jobs (record issuance, expiry, audit — SPEC §5.4) are added in later changes.
// The api container owns migrations; the worker only connects.
const conn = await connectFromEnv("openglass-worker");
const health = buildHealthServer(() => conn.db.command({ ping: 1 }));
await health.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3003) });
console.log("[worker] started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await health.close();
    await conn.close();
    process.exit(0);
  });
}
