import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Trace files from the monorepo root so the standalone bundle includes workspace deps.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // No sharp: images are built on the build platform and may run on arm64.
  images: { unoptimized: true },
  poweredByHeader: false,
  // /docs/* and /spec/* are static (copied into public/ at build time — see
  // apps/web/Dockerfile) so their content-type would otherwise be inferred from the
  // extension (text/markdown, text/yaml, application/json). Several AI web-fetch tools
  // refuse or mishandle less-common MIME types (confirmed by a real agent's fetch failing
  // on this exact path) — text/plain is universally readable and the content is still
  // perfectly fine markdown/YAML/JSON source either way.
  async headers() {
    return [
      { source: "/docs/:path*", headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }] },
      { source: "/spec/:path*", headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }] },
    ];
  },
};

export default config;
