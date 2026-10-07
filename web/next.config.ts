import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const config: NextConfig = {
  // the studio imports the pipeline's schemas, pure functions and the Remotion composition from ../src
  outputFileTracingRoot: repoRoot,
  // the queue client is loaded by Node at run time, not bundled: bundling it trips over its optional drivers
  serverExternalPackages: ["bullmq", "ioredis"],
  // ../src imports TypeScript files with ".js" extensions (NodeNext); only webpack can be taught that, so the
  // studio runs Next with --webpack (Turbopack ignores extensionAlias)
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
};

export default config;
