import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for native modules to work on Vercel
  serverExternalPackages: [
    "@google-cloud/documentai",
    "google-auth-library",
    "sharp",
    "@napi-rs/canvas"
  ],
};

export default nextConfig;
