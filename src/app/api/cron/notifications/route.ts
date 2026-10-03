import { NextResponse } from "next/server";
import { safeEqual } from "@/server/auth/crypto";
import { pruneRateLimits } from "@/server/auth/rate-limit";
import { env } from "@/server/env";
import { pruneAnalyticsEvents } from "@/server/analytics-intake";
import { generateAllNotifications } from "@/server/services/notification-jobs";
import { deleteExpiredReceiptImages } from "@/server/services/receipt-privacy";
import { resumeStalledReceipts } from "@/server/services/receipts";

export const maxDuration = 300;

/**
 * Scheduled job (e.g. hourly): pick up receipts whose reading was interrupted,
 * generate useful notifications for every household, delete receipt photos whose
 * retention time is up and prune old analytics. Protected by CRON_SECRET.
 */
async function handle(request: Request) {
  const secret = env().CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const receipts = await resumeStalledReceipts();
  const result = await generateAllNotifications();
  await pruneRateLimits();
  // Privacy housekeeping: receipt photos whose time is up, and old analytics.
  const photos = await deleteExpiredReceiptImages();
  const analytics = await pruneAnalyticsEvents();
  return NextResponse.json({ ok: true, ...result, receipts, photos, analyticsPruned: analytics });
}

export const GET = handle;
export const POST = handle;
