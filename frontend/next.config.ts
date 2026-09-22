import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "../public",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
