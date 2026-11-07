import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEMO_NEXT_DIST_DIR || ".next",
  allowedDevOrigins: process.env.NODE_ENV === "development"
    ? [new URL(process.env.APP_URL || "http://localhost:3000").hostname]
    : [],
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/admin/ipa-releases/**": ["./scripts/ios/package.py", "./scripts/ios/macho.py", "./scripts/ios/verify.py", "./scripts/ios/apple-chain.pem"],
    "/api/admin/installations/**": ["./scripts/ios/package.py", "./scripts/ios/macho.py", "./scripts/ios/verify.py", "./scripts/ios/apple-chain.pem"],
    "/api/admin/device-profiles/**": ["./scripts/ios/certificate_status.py", "./scripts/ios/package.py", "./scripts/ios/macho.py", "./scripts/ios/verify.py", "./scripts/ios/apple-chain.pem"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.local/**/*", "./.env*", "./web/**/*", "./scripts/ios/__pycache__/**/*"],
  },
  turbopack: {
    rules: {
      // Only the Tailwind entry needs this loader. Rewriting *.module.css as
      // *.css removes CSS Modules exports and leaves component classes empty.
      "globals.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
