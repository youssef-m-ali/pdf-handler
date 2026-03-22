import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    // Prevent canvas native module errors during SSR
    config.resolve.alias.canvas = false;
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    // Force webpack to use the CJS build of ghostscript-wasm instead of the
    // ESM build (gs.mjs), which contains dynamic import("module") that webpack
    // cannot resolve in the browser.
    config.resolve.alias["@jspawn/ghostscript-wasm"] = path.resolve(
      "node_modules/@jspawn/ghostscript-wasm/gs.js"
    );
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        module: false,
      };
    }
    return config;
  },
};

export default nextConfig;
