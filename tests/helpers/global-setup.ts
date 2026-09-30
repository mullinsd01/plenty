/**
 * Vitest global setup. Points integration tests at a dedicated test database
 * (plenty_test by default), resets it and applies migrations + the catalog.
 * Pure unit tests don't touch the database.
 */
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";

export default async function setup() {
  loadEnvConfig(process.cwd());
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?|$)/, "/plenty_test$2");
  if (!base) return;
  process.env.DATABASE_URL = base;
  process.env.TEST_DATABASE_URL = base;
  const needsDb = process.argv.some((a) => a.includes("integration")) || !process.argv.some((a) => a.includes("tests/unit"));
  if (!needsDb) return;
  const pool = new Pool({ connectionString: base, max: 1 });
  try {
    await pool.query("select 1");
  } catch {
    console.warn(`[tests] Test database unavailable at ${base.replace(/:[^:@/]*@/, ":***@")}; integration tests will fail.`);
    await pool.end();
    return;
  }
  await pool.query("drop schema if exists public cascade; drop schema if exists app cascade; drop schema if exists drizzle cascade; create schema public;");
  await pool.end();
  const { runMigrations } = await import("../../scripts/migrate");
  await runMigrations(base);
}
