/**
 * Run the notifications job once (use with cron / a scheduler, or call
 * POST /api/cron/notifications with the CRON_SECRET bearer token).
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { generateAllNotifications } = await import("../src/server/services/notifications");
  const result = await generateAllNotifications();
  console.log(`✓ ${result.created} notifications across ${result.households} households`);
  const { pool } = await import("../src/server/db/client");
  await pool.end();
}

main().catch((err) => {
  console.error("✗ Notifications job failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
