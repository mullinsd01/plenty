import "server-only";
import { validateClientEvent, MAX_ANALYTICS_BODY } from "@/lib/analytics-validate";
import { detectPlatform } from "@/lib/billing/platform";
import type { HouseholdContext } from "@/server/auth/context";
import { checkRateLimit } from "@/server/auth/rate-limit";
import { lt } from "drizzle-orm";
import { analyticsSubject, track } from "@/server/analytics";
import { systemDb } from "@/server/db/client";
import { analyticsEvents } from "@/server/db/schema";

/** At most this many client events per person per minute. */
export const ANALYTICS_RATE_LIMIT = { limit: 120, windowSeconds: 60 } as const;

export type IntakeResult =
  | { status: 202; recorded: boolean }
  | { status: 400; error: string }
  | { status: 413; error: string }
  | { status: 429; error: string; retryAfterSeconds: number };

/**
 * Accept an analytics event from a signed-in client. Validates strictly,
 * rate limits per person, and records nothing when analytics is off for the
 * person or for the server (production without ANALYTICS_SECRET). Answers
 * "accepted" either way, so a client can't tell the difference.
 */
export async function recordClientAnalytics(ctx: HouseholdContext, rawBody: string, headers: { get(name: string): string | null }): Promise<IntakeResult> {
  if (rawBody.length > MAX_ANALYTICS_BODY) return { status: 413, error: "That's too big for an analytics event." };
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, error: "That isn't a valid analytics event." };
  }
  const checked = validateClientEvent(body);
  if (!checked.ok) return { status: 400, error: checked.reason };

  const limited = await checkRateLimit(`analytics:${ctx.user.id}`, ANALYTICS_RATE_LIMIT.limit, ANALYTICS_RATE_LIMIT.windowSeconds);
  if (!limited.ok) return { status: 429, error: "Too many events. Slow down.", retryAfterSeconds: limited.retryAfterSeconds };

  // Off for the whole server (no secret in production): nothing to do, and nothing is recorded.
  if (analyticsSubject(ctx.household.id) === null) return { status: 202, recorded: false };
  // `track` also checks this person's own opt-out before writing anything.
  await track(checked.event, { householdId: ctx.household.id, userId: ctx.user.id, plan: ctx.plan.plan, platform: detectPlatform(headers) }, checked.props);
  return { status: 202, recorded: true };
}

/** Analytics events are kept this long, then deleted. */
export const ANALYTICS_RETENTION_DAYS = 395;

/** Scheduled job: delete analytics older than the retention period. Idempotent. */
export async function pruneAnalyticsEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * 86_400_000);
  const removed = await systemDb.delete(analyticsEvents).where(lt(analyticsEvents.occurredAt, cutoff)).returning({ id: analyticsEvents.id });
  return removed.length;
}
