import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Trace files from the monorepo root so the standalone bundle includes workspace deps.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // No sharp: images are built on the build platform and may run on arm64.
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default config;
