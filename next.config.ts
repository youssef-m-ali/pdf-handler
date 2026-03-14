import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    // Prevent canvas native module errors during SSR
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
