import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
  // Browsers ignore this over plain http, so it only takes effect where Plenty is served over https.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // A self-contained server (.next/standalone) for the Docker image: see Dockerfile and docs/deploy.md.
  output: "standalone",
  // The floating dev badge covers the bottom navigation on phones.
  devIndicators: false,
  poweredByHeader: false,
  // Native / WASM packages that must not be bundled into server chunks.
  serverExternalPackages: [
    "tesseract.js",
    "tesseract.js-core",
    "@tesseract.js-data/eng",
    "sharp",
    "@node-rs/argon2",
    "pg",
    "nodemailer",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
