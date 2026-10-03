import "server-only";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { sanitizeAnalyticsProps, type AnalyticsEvent, type AnalyticsProps } from "@/lib/analytics-events";
import type { PlanId } from "@/lib/billing/plans";
import { systemDb } from "@/server/db/client";
import { analyticsEvents, profiles } from "@/server/db/schema";
import { isProduction } from "@/server/env";

export type AnalyticsPlatform = "web" | "ios" | "android";

export interface AnalyticsContext {
  householdId: string;
  /** Whoever caused it. Their opt-out is respected, and their id is never stored. */
  userId?: string | null;
  plan?: PlanId | null;
  platform?: AnalyticsPlatform;
}

/**
 * A pseudonymous key for a household: events from the same household group
 * together without containing its id. Without a configured secret,
 * production records nothing rather than using a guessable key.
 */
export function analyticsSubject(householdId: string): string | null {
  const secret = process.env.ANALYTICS_SECRET ?? (isProduction() ? undefined : "plenty-development-analytics");
  if (!secret) return null;
  return createHmac("sha256", secret).update(householdId).digest("hex").slice(0, 32);
}

/**
 * Record a product event. First-party only: nothing is sent to anyone else.
 * Best effort: analytics never break the app, so failures are swallowed.
 */
export async function track(event: AnalyticsEvent, ctx: AnalyticsContext, props?: AnalyticsProps): Promise<void> {
  try {
    const subject = analyticsSubject(ctx.householdId);
    if (!subject) return;
    if (ctx.userId) {
      const [profile] = await systemDb.select({ optOut: profiles.analyticsOptOut }).from(profiles).where(eq(profiles.userId, ctx.userId)).limit(1);
      if (profile?.optOut) return;
    }
    const clean = sanitizeAnalyticsProps(event, props);
    await systemDb.insert(analyticsEvents).values({
      event,
      subject,
      plan: ctx.plan ?? null,
      platform: ctx.platform ?? "web",
      props: Object.keys(clean).length > 0 ? JSON.stringify(clean) : null,
    });
  } catch (err) {
    console.warn("[analytics] event not recorded:", err instanceof Error ? err.message : err);
  }
}

/** Remove everything recorded for a household (used when the household is deleted). */
export async function deleteAnalyticsFor(householdId: string): Promise<void> {
  const subject = analyticsSubject(householdId);
  if (!subject) return;
  await systemDb.delete(analyticsEvents).where(eq(analyticsEvents.subject, subject));
}
