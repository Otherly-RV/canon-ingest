import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep google-auth-library external to avoid bundling issues
  serverExternalPackages: ["google-auth-library"],
};

export default nextConfig;
