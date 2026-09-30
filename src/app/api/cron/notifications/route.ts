import { NextResponse } from "next/server";
import { safeEqual } from "@/server/auth/crypto";
import { pruneRateLimits } from "@/server/auth/rate-limit";
import { env } from "@/server/env";
import { generateAllNotifications } from "@/server/services/notification-jobs";

export const maxDuration = 300;

/**
 * Scheduled job (e.g. hourly): generate useful notifications for every
 * household. Protected by CRON_SECRET.
 */
async function handle(request: Request) {
  const secret = env().CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await generateAllNotifications();
  await pruneRateLimits();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
