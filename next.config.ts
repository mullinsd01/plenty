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
  // Lets the dev server be previewed through a GitHub Codespaces forwarded port (see .devcontainer). No effect in production.
  allowedDevOrigins: ["*.app.github.dev"],
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
  // The standalone server only gets the files that tracing can see. tesseract.js starts its OCR worker from a
  // file path and loads its WASM engine and English model with fs, which tracing can't follow, so name them.
  // Only the LSTM engine is shipped (the app never asks for the legacy one); the server picks the variant for its CPU.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/tesseract.js/package.json",
      "./node_modules/tesseract.js/src/**/*",
      "./node_modules/tesseract.js-core/package.json",
      "./node_modules/tesseract.js-core/index.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm",
      "./node_modules/@tesseract.js-data/eng/package.json",
      "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
      "./node_modules/wasm-feature-detect/package.json",
      "./node_modules/wasm-feature-detect/dist/cjs/**/*",
      "./node_modules/bmp-js/package.json",
      "./node_modules/bmp-js/index.js",
      "./node_modules/bmp-js/lib/**/*",
    ],
  },
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
