import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for @google-cloud/documentai to work on Vercel
  serverExternalPackages: ["@google-cloud/documentai"],
};

export default nextConfig;
