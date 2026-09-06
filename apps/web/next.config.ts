import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
