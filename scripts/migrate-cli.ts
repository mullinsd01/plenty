/**
 * Entry point for `node tools/migrate.cjs` in the Docker image (scripts/build-tools.mjs bundles it): apply the
 * database migrations and nothing else. `npm run db:migrate` runs scripts/migrate.ts directly.
 */
import { runMigrations } from "./migrate";

runMigrations()
  .then(() => {
    console.log("✓ Migrations applied");
  })
  .catch((err) => {
    console.error("✗ Migration failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
