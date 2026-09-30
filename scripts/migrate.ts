/**
 * Apply database migrations (schema, extensions, row-level security).
 *   npm run db:migrate
 */
import { loadEnvConfig } from "@next/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

loadEnvConfig(process.cwd());

export async function runMigrations(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations()
    .then(() => {
      console.log("✓ Migrations applied");
    })
    .catch((err) => {
      console.error("✗ Migration failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
