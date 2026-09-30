/**
 * One-time (and idempotent) setup:
 *   1. apply migrations (schema, extensions, row-level security)
 *   2. load Plenty's product catalog
 *   3. load the built-in recipe library
 *
 *   npm run setup
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { runMigrations } = await import("./migrate");
  await runMigrations();
  console.log("✓ Database migrated");

  const { syncCatalog } = await import("../src/server/services/products");
  const products = await syncCatalog();
  console.log(`✓ Product catalog loaded (${products} products)`);

  const { syncRecipeLibrary } = await import("../src/server/services/meals");
  const recipes = await syncRecipeLibrary();
  console.log(`✓ Recipe library loaded (${recipes} recipes)`);

  const { pool } = await import("../src/server/db/client");
  await pool.end();
}

main().catch((err) => {
  console.error("✗ Setup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
