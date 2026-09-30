/**
 * Run the scheduled jobs once: resume interrupted receipt reading, then
 * generate notifications. Use with cron / a scheduler, or call
 * POST /api/cron/notifications with the CRON_SECRET bearer token.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const { resumeStalledReceipts } = await import("../src/server/services/receipts");
  const receipts = await resumeStalledReceipts();
  if (receipts.restarted || receipts.failed) {
    console.log(`✓ Receipts: ${receipts.restarted} restarted, ${receipts.failed} marked as interrupted`);
  }
  const { generateAllNotifications } = await import("../src/server/services/notification-jobs");
  const result = await generateAllNotifications();
  console.log(`✓ ${result.created} notifications across ${result.households} households`);
  const { terminateOcrWorker } = await import("../src/server/receipts/ocr");
  await terminateOcrWorker();
  const { pool } = await import("../src/server/db/client");
  await pool.end();
}

main().catch((err) => {
  console.error("✗ Notifications job failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
