import "server-only";
import { sql } from "drizzle-orm";
import { systemDb } from "@/server/db/client";
import { AppError } from "@/server/errors";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter backed by Postgres, so it holds across server
 * instances. One atomic upsert per check.
 */
export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const result = await systemDb.execute<{ count: number; window_start: Date }>(sql`
    insert into rate_limits (key, window_start, count)
    values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
                   then now() else rate_limits.window_start end
    returning count, window_start
  `);
  const row = result.rows[0];
  const count = Number(row?.count ?? 1);
  const windowStart = row?.window_start ? new Date(row.window_start) : new Date();
  const retryAfterSeconds = Math.max(1, Math.ceil(windowSeconds - (Date.now() - windowStart.getTime()) / 1000));
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
}

/** Throw a friendly rate-limit error when the limit is exceeded. */
export async function enforceRateLimit(key: string, limit: number, windowSeconds: number, what = "that"): Promise<void> {
  const res = await checkRateLimit(key, limit, windowSeconds);
  if (!res.ok) {
    const wait = res.retryAfterSeconds > 90 ? `${Math.ceil(res.retryAfterSeconds / 60)} minutes` : `${res.retryAfterSeconds} seconds`;
    throw new AppError("rate_limited", `You've tried ${what} a few too many times. Please wait ${wait} and try again.`);
  }
}

/** Opportunistically clear old counters (called from the cron job). */
export async function pruneRateLimits(): Promise<void> {
  await systemDb.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`);
}
