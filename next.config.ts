import type { NextConfig } from "next";

// In development the app may be previewed inside an editor (VS Code's Simple Browser in a Codespace is a frame), so
// framing is allowed from those hosts only when not in production. Production never allows being framed.
const isProduction = process.env.NODE_ENV === "production";
const frameAncestors = isProduction ? "'none'" : "'self' https://*.github.dev https://*.app.github.dev https://*.vscode-cdn.net";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  ...(isProduction ? [{ key: "X-Frame-Options", value: "DENY" }] : []),
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors}; base-uri 'self'; form-action 'self'` },
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
  // The standalone server only gets the files that tracing can see. tesseract.js starts its OCR worker from a file
  // path and loads its WASM engine and the English model with fs, so tracing can't follow them: name them. The worker
  // picks the engine variant for the server's CPU when it starts (and tesseract.js 7.0.0 loads the full engine, not the
  // LSTM-only one, in Node), so every variant ships. `docker build` fails if any of these is missing from the output.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/tesseract.js/package.json",
      "./node_modules/tesseract.js/src/**/*",
      "./node_modules/tesseract.js-core/package.json",
      "./node_modules/tesseract.js-core/index.js",
      "./node_modules/tesseract.js-core/tesseract-core.js",
      "./node_modules/tesseract.js-core/tesseract-core.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-simd.js",
      "./node_modules/tesseract.js-core/tesseract-core-simd.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd.js",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm",
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
      // A Codespaces forwarded port reaches the app as localhost:3000 while the browser's origin is the public
      // *.app.github.dev address, which Next treats as a forged request. Allowed while developing only; in production
      // a form is accepted only from the site's own address.
      ...(isProduction ? {} : { allowedOrigins: ["*.app.github.dev", "localhost:3000"] }),
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
