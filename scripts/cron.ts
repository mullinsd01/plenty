/**
 * Run the scheduled jobs once: resume interrupted receipt reading, generate
 * notifications, delete receipt photos whose time is up and prune old analytics. Use with cron / a scheduler, or call
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
  const { deleteExpiredReceiptImages } = await import("../src/server/services/receipt-privacy");
  const photos = await deleteExpiredReceiptImages();
  if (photos.deleted || photos.failed) console.log(`✓ Receipt photos: ${photos.deleted} deleted${photos.failed ? `, ${photos.failed} couldn't be removed (will retry)` : ""}`);
  const { pruneAnalyticsEvents } = await import("../src/server/analytics-intake");
  const pruned = await pruneAnalyticsEvents();
  if (pruned) console.log(`✓ Analytics: ${pruned} old events deleted`);
  const { pruneExpiredAuthRecords } = await import("../src/server/services/housekeeping");
  const signIns = await pruneExpiredAuthRecords();
  if (signIns.sessions || signIns.resetTokens) console.log(`✓ Sign-in records: ${signIns.sessions} expired sessions and ${signIns.resetTokens} spent reset links deleted`);
  const { terminateOcrWorker } = await import("../src/server/receipts/ocr");
  await terminateOcrWorker();
  const { pool } = await import("../src/server/db/client");
  await pool.end();
}

main().catch((err) => {
  console.error("✗ Notifications job failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
