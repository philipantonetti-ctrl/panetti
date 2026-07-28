import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  env: {
    // Inlined into every bundle, server and client alike, so an open tab can
    // tell when a newer deployment exists and reload itself (see FreshBuild).
    // 'dev' outside Vercel, where there is nothing to keep in step with.
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  },
};

export default nextConfig;
