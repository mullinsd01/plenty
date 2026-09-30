/**
 * Development only: drop everything, re-run setup and re-seed the demo.
 *   npm run db:reset
 */
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";

loadEnvConfig(process.cwd());

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database.");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await pool.query("drop schema if exists public cascade; drop schema if exists app cascade; drop schema if exists drizzle cascade; create schema public;");
  await pool.end();
  console.log("✓ Database cleared");
  const { execSync } = await import("node:child_process");
  execSync("npm run setup", { stdio: "inherit" });
  execSync("npm run db:seed", { stdio: "inherit" });
}

main().catch((err) => {
  console.error("✗ Reset failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
