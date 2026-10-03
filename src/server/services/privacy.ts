import "server-only";
import { eq } from "drizzle-orm";
import { cheapestPlanWith, PLANS, type PlanId } from "@/lib/billing/plans";
import { denialMessage, EXTERNAL_AI_PROVIDER } from "@/lib/ai/consent";
import { aiStatus, resolveAiAccess } from "@/server/ai";
import type { AuthUser, HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { env } from "@/server/env";
import type { ProcessorConfig } from "@/lib/privacy-content";
import { preferences, profiles } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { requireCapability } from "@/server/permissions";
import { applyRetentionToExisting, deleteExpiredReceiptImages, isRetentionPolicy, type ReceiptImageRetention } from "./receipt-privacy";

/**
 * The household's privacy choices: whether Plenty may use an outside AI
 * service, how long receipt photos are kept, and (per person) analytics.
 * Each has its own function so a choice can only be changed on purpose: the
 * general preferences form can't touch any of them.
 */

export interface AiConsentView {
  /** An outside AI service is set up on this server. */
  configured: boolean;
  providerName: string;
  termsUrl: string;
  /** The household's plan includes AI-assisted features. */
  entitled: boolean;
  /** The cheapest plan that includes them, for "Available on Plenty Plus". */
  upgradePlan: { id: PlanId; name: string } | null;
  /** The household has said yes (recorded). */
  consented: boolean;
  consentAt: string | null;
  consentByName: string | null;
  /** Data may go to the provider right now: configured, entitled and consented. */
  active: boolean;
  /** This person may change the answer. */
  canChange: boolean;
}

export async function getAiConsentView(ctx: HouseholdContext): Promise<AiConsentView> {
  const access = await resolveAiAccess(ctx.household.id);
  let byName: string | null = null;
  if (access.consent.by) {
    const by = access.consent.by;
    byName = await withUser(ctx.user.id, async (tx) => {
      const [p] = await tx.select({ name: profiles.displayName }).from(profiles).where(eq(profiles.userId, by)).limit(1);
      return p?.name ?? null;
    });
  }
  const upgrade = cheapestPlanWith((e) => e.receipt_extraction === "advanced");
  const consented = access.consent.allowed && access.consent.at !== null;
  return {
    configured: access.configured,
    providerName: EXTERNAL_AI_PROVIDER.name,
    termsUrl: EXTERNAL_AI_PROVIDER.termsUrl,
    entitled: access.entitled,
    upgradePlan: upgrade ? { id: upgrade, name: PLANS[upgrade].name } : null,
    consented,
    consentAt: consented ? access.consent.at!.toISOString() : null,
    consentByName: consented ? byName : null,
    active: access.decision.allowed,
    canChange: ctx.role !== "child",
  };
}

/**
 * Say yes or no to sending household data to the outside AI service. An owner
 * or member can answer; the answer is recorded (who and when) and withdrawing
 * it takes effect on the very next request. A "yes" needs something to say yes
 * to: a configured service and a plan that includes it.
 */
export async function setAiConsent(ctx: HouseholdContext, granted: boolean): Promise<void> {
  requireCapability(ctx, "change_settings");
  if (granted) {
    if (ctx.household.isDemo) throw new AppError("forbidden", "The demo household is shared, so it can't send anything to an AI service.");
    const access = await resolveAiAccess(ctx.household.id);
    if (!access.configured) throw new AppError("ai_unavailable", denialMessage("not_configured"));
    if (!access.entitled) throw new AppError("plan_limit", denialMessage("plan"));
  }
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const [current] = await tx
      .select({ allowed: preferences.allowAiProcessing, at: preferences.aiConsentAt })
      .from(preferences)
      .where(eq(preferences.householdId, ctx.household.id))
      .limit(1);
    // Saying yes again keeps the original record of who agreed and when.
    if (granted && current?.allowed && current.at) return;
    const patch = granted
      ? { allowAiProcessing: true, aiConsentAt: now, aiConsentBy: ctx.user.id }
      : { allowAiProcessing: false, aiConsentAt: null, aiConsentBy: null };
    await tx
      .insert(preferences)
      .values({ householdId: ctx.household.id, ...patch })
      .onConflictDoUpdate({ target: preferences.householdId, set: patch });
  });
}

/** How long receipt photos are kept, and a nudge to apply it to the photos already stored. */
export async function setReceiptImageRetention(ctx: HouseholdContext, policy: ReceiptImageRetention): Promise<void> {
  requireCapability(ctx, "change_settings");
  if (!isRetentionPolicy(policy)) throw new AppError("validation", "Choose how long to keep receipt photos.");
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .insert(preferences)
      .values({ householdId: ctx.household.id, receiptImageRetention: policy })
      .onConflictDoUpdate({ target: preferences.householdId, set: { receiptImageRetention: policy } });
    await applyRetentionToExisting(tx, ctx.household.id, policy, now);
  });
  if (policy === "after_review") {
    // Photos already checked go now rather than at the next scheduled sweep.
    await deleteExpiredReceiptImages(now, { householdId: ctx.household.id }).catch((err) => console.error("[privacy] photo removal failed; the scheduled sweep will retry:", err));
  }
}

export async function getAnalyticsOptOut(user: AuthUser): Promise<boolean> {
  return withUser(user.id, async (tx) => {
    const [p] = await tx.select({ optOut: profiles.analyticsOptOut }).from(profiles).where(eq(profiles.userId, user.id)).limit(1);
    return p?.optOut ?? false;
  });
}

/** Per person, not per household: turning analytics off applies to everything this person does. */
export async function setAnalyticsOptOut(user: AuthUser, optOut: boolean): Promise<void> {
  await withUser(user.id, async (tx) => {
    await tx.update(profiles).set({ analyticsOptOut: optOut }).where(eq(profiles.userId, user.id));
  });
}

/** Which outside companies this Plenty is set up to use, for the privacy pages. Only what's configured is listed. */
export function processorConfig(): ProcessorConfig {
  const e = env();
  const ai = aiStatus();
  return {
    email: Boolean(e.SMTP_URL),
    stripe: Boolean(e.STRIPE_SECRET_KEY),
    apple: Boolean(e.APPLE_BUNDLE_ID),
    google: Boolean(e.GOOGLE_PLAY_PACKAGE_NAME),
    aiConfigured: ai.externalConfigured,
    aiProviderName: ai.providerName ?? EXTERNAL_AI_PROVIDER.name,
  };
}
