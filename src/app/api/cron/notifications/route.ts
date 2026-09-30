import { NextResponse } from "next/server";
import { safeEqual } from "@/server/auth/crypto";
import { pruneRateLimits } from "@/server/auth/rate-limit";
import { env } from "@/server/env";
import { generateAllNotifications } from "@/server/services/notification-jobs";
import { resumeStalledReceipts } from "@/server/services/receipts";

export const maxDuration = 300;

/**
 * Scheduled job (e.g. hourly): pick up receipts whose reading was interrupted,
 * then generate useful notifications for every household. Protected by CRON_SECRET.
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
  return NextResponse.json({ ok: true, ...result, receipts });
}

export const GET = handle;
export const POST = handle;
