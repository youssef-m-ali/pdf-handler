import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let Node.js require() ghostscript-wasm directly — don't bundle it through
  // webpack so the .wasm file is loaded from node_modules, not vendor-chunks.
  serverExternalPackages: ["@jspawn/ghostscript-wasm", "pdfjs-dist"],
  webpack: (config, { isServer }) => {
    // Prevent canvas native module errors during SSR
    config.resolve.alias.canvas = false;
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
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
