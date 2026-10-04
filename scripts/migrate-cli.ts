/**
 * Entry point for `node tools/migrate.cjs` in the Docker image (scripts/build-tools.mjs bundles it): apply the
 * database migrations and nothing else. `npm run db:migrate` runs scripts/migrate.ts directly.
 */
import { runMigrations } from "./migrate";
import { explainDatabaseError } from "./lib/explain-error";

runMigrations()
  .then(() => {
    console.log("✓ Migrations applied");
  })
  .catch((err) => {
    console.error("✗ Migration failed:", explainDatabaseError(err));
    process.exit(1);
  });
