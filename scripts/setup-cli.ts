/**
 * Entry point for `node tools/setup.cjs` in the Docker image (scripts/build-tools.mjs bundles it): the same three
 * steps as scripts/setup.ts (`npm run setup`), with failures explained in words. Keep the steps in step with it.
 *
 *   1. apply migrations (schema, extensions, row-level security)
 *   2. load Plenty's product catalog
 *   3. load the built-in recipe library
 *
 * Idempotent: run it before every new version starts.
 */
import { loadEnvConfig } from "@next/env";
import { explainDatabaseError } from "./lib/explain-error";

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
  console.error("✗ Setup failed:", explainDatabaseError(err));
  process.exit(1);
});
