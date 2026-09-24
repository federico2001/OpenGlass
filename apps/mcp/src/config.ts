import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** apps/api reached directly over the Docker network — never through Caddy/TLS. */
  API_INTERNAL_URL: z.url().default("http://api:3000"),
  /** The public origin agents see this server at (mcp.<domain>) — used only in server.json
   * and tool-description text, never for actual requests (those go to API_INTERNAL_URL). */
  PUBLIC_MCP_URL: z.url().default("https://mcp.localhost"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
