import type { NextConfig } from "next";

const MAX_UPLOAD_MB = 25;

const nextConfig: NextConfig = {
  experimental: {
    // Server actions cap request bodies at 1MB by default, which rejects most PDFs and DOCX
    // files before the action even runs. Raised to a bounded limit that matches what the
    // library page validates against, so the two can't disagree.
    serverActions: { bodySizeLimit: `${MAX_UPLOAD_MB}mb` },
  },
  // The workspace packages ship TypeScript source (no build step), so Next must compile them.
  transpilePackages: ["@hearth/core", "@hearth/db", "@hearth/agents"],
  webpack(config) {
    // Those packages are NodeNext ESM, so they import siblings as "./foo.js" while the file on
    // disk is "./foo.ts". Teach the bundler that mapping instead of forcing a build step.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
};

export default nextConfig;
