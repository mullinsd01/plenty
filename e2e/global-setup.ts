import { execSync } from "node:child_process";
import { Pool } from "pg";

/** Fresh database for every e2e run: drop, migrate, load catalog + recipes. */
export default async function globalSetup() {
  const url = process.env.E2E_DATABASE_URL ?? "postgres://plenty:plenty@localhost:5432/plenty_e2e";
  const pool = new Pool({ connectionString: url, max: 1 });
  await pool.query("drop schema if exists public cascade; drop schema if exists app cascade; drop schema if exists drizzle cascade; create schema public;");
  await pool.end();
  execSync("npx tsx --conditions=react-server scripts/setup.ts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
