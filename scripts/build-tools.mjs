/**
 * Bundle the operational scripts into single files that run on plain Node, with no TypeScript and no
 * dev dependencies, so the production Docker image can run them:
 *
 *   node tools/migrate.cjs      apply database migrations
 *   node tools/setup.cjs        migrations + product catalog + recipe library (run on every deploy; idempotent)
 *   node tools/seed.cjs         recreate the demo household (App Review)
 *   node tools/cron.cjs         run the scheduled jobs once
 *   node tools/check-prod.cjs   the go-live check
 *   node tools/smoke.cjs        proves the image can hash passwords, process photos and read receipts
 *
 * Usage: node scripts/build-tools.mjs [outdir]   (default: dist-tools). The Dockerfile builds into tools/; `npm run build:tools` for a local copy.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outdir = process.argv[2] ?? "dist-tools";

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: {
    migrate: "scripts/migrate-cli.ts",
    setup: "scripts/setup.ts",
    seed: "scripts/seed.ts",
    cron: "scripts/cron.ts",
    "check-prod": "scripts/check-prod.ts",
    smoke: "scripts/image-smoke.ts",
  },
  outdir,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // The same condition `tsx --conditions=react-server` uses: it turns `import "server-only"` into a no-op outside Next.js.
  conditions: ["react-server"],
  tsconfig: "tsconfig.json",
  // Native or WASM packages, and ones the app loads by file path, come from the image's node_modules (the Next.js
  // standalone output ships them; see outputFileTracingIncludes in next.config.ts), exactly as in the web server.
  external: ["sharp", "@node-rs/argon2", "tesseract.js", "tesseract.js-core", "@tesseract.js-data/eng", "nodemailer", "@aws-sdk/client-s3", "pg-native"],
  logLevel: "info",
  legalComments: "none",
});
