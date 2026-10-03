/**
 * What plan a household actually has right now, from its stored subscription.
 *
 * The same rules apply whichever provider the subscription came from (web,
 * App Store, Google Play), because the provider layer normalises everything
 * into this state before it's stored. Pure and deterministic: `now` is a
 * parameter.
 */

import type { BillingPeriod, PlanId } from "./plans";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "paused" | "canceled" | "expired" | "refunded";
export type BillingProviderId = "web" | "apple" | "google" | "manual";

export interface SubscriptionState {
  plan: PlanId;
  period: BillingPeriod | null;
  status: SubscriptionStatus;
  provider: BillingProviderId;
  autoRenew: boolean;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  pendingPlan: PlanId | null;
  pendingPeriod: BillingPeriod | null;
  /**
   * When the newest provider event that has been applied happened. The state
   * machine (`events.ts`) uses it to ignore notifications that arrive late
   * and would otherwise undo something newer. Absent on hand-built states.
   */
  lastEventAt?: Date | null;
}

/**
 * Renewals are confirmed by the provider shortly after a period ends. Rather
 * than cut off a paying household because a notification is late, an active,
 * auto-renewing subscription keeps its plan for this long past its end.
 */
export const RENEWAL_TOLERANCE_MS = 3 * 24 * 3600_000;

export type EffectiveReason =
  | "no_subscription"
  | "active"
  | "trial"
  | "trial_ended"
  | "cancelled_until_period_end"
  | "grace_period"
  | "payment_failed"
  | "paused"
  | "ended"
  | "refunded"
  | "stale";

export interface EffectivePlan {
  /** The plan whose entitlements apply. */
  plan: PlanId;
  /** The plan on the subscription, even when it isn't currently in force. */
  subscribedPlan: PlanId | null;
  reason: EffectiveReason;
  /** The subscription will renew on its own. */
  willRenew: boolean;
  /** When access ends or renews, if known. */
  until: Date | null;
  /** Payment failed and access continues for now: ask the household to fix their payment method. */
  needsPaymentAttention: boolean;
  /** A change (such as a downgrade) takes effect at the next renewal. */
  pendingChange: { plan: PlanId; period: BillingPeriod | null } | null;
  provider: BillingProviderId | null;
}

const FREE_RESULT: EffectivePlan = {
  plan: "free",
  subscribedPlan: null,
  reason: "no_subscription",
  willRenew: false,
  until: null,
  needsPaymentAttention: false,
  pendingChange: null,
  provider: null,
};

function after(date: Date | null, now: Date, toleranceMs = 0): boolean {
  return date !== null && now.getTime() <= date.getTime() + toleranceMs;
}

/** The plan in force for a subscription at `now`. A missing subscription is the free plan. */
export function resolveEffectivePlan(sub: SubscriptionState | null, now: Date): EffectivePlan {
  if (!sub || sub.plan === "free") return FREE_RESULT;

  const pendingChange = sub.pendingPlan ? { plan: sub.pendingPlan, period: sub.pendingPeriod } : null;
  const base = {
    subscribedPlan: sub.plan,
    until: sub.currentPeriodEnd,
    pendingChange,
    provider: sub.provider,
  };
  const free = (reason: EffectiveReason): EffectivePlan => ({
    ...base,
    plan: "free",
    reason,
    willRenew: false,
    needsPaymentAttention: false,
  });

  switch (sub.status) {
    case "trialing":
      if (after(sub.trialEndsAt, now)) {
        return { ...base, plan: sub.plan, reason: "trial", willRenew: sub.autoRenew, until: sub.trialEndsAt, needsPaymentAttention: false };
      }
      // A trial that converts to a paid plan is confirmed by the provider just after it ends, the same
      // as a renewal: don't cut off a household that is about to start paying because that is late.
      if (sub.autoRenew && after(sub.trialEndsAt, now, RENEWAL_TOLERANCE_MS)) {
        return { ...base, plan: sub.plan, reason: "active", willRenew: true, until: sub.trialEndsAt, needsPaymentAttention: false };
      }
      return free("trial_ended");

    case "active":
      // An active subscription whose period has lapsed with no renewal is not paid. If it was meant to
      // renew, the confirmation is missing ("stale"); if it wasn't, it simply ended.
      if (sub.currentPeriodEnd && !after(sub.currentPeriodEnd, now, sub.autoRenew ? RENEWAL_TOLERANCE_MS : 0)) {
        return free(sub.autoRenew ? "stale" : "ended");
      }
      return { ...base, plan: sub.plan, reason: "active", willRenew: sub.autoRenew, needsPaymentAttention: false };

    case "canceled":
      // Cancelled means "won't renew": the household keeps what it paid for until the period ends.
      if (after(sub.currentPeriodEnd, now)) {
        return { ...base, plan: sub.plan, reason: "cancelled_until_period_end", willRenew: false, needsPaymentAttention: false };
      }
      return free("ended");

    case "past_due": {
      // The provider is retrying the payment. Access continues through its grace period, then stops.
      // Time that was already paid for is never taken back early because a later payment failed.
      const paidThrough = [sub.graceEndsAt, sub.currentPeriodEnd].reduce<Date | null>(
        (latest, d) => (d && (!latest || d.getTime() > latest.getTime()) ? d : latest),
        null,
      );
      if (after(paidThrough, now)) {
        return { ...base, plan: sub.plan, reason: "grace_period", willRenew: sub.autoRenew, until: paidThrough, needsPaymentAttention: true };
      }
      return { ...free("payment_failed"), needsPaymentAttention: true };
    }

    case "paused":
      return free("paused");

    case "refunded":
      return free("refunded");

    case "expired":
      return free("ended");
  }
}

/** A short, honest sentence about the household's plan for the plan page. */
export function describeEffectivePlan(effective: EffectivePlan, planName: string, dateText: (date: Date) => string): string {
  const until = effective.until ? dateText(effective.until) : null;
  switch (effective.reason) {
    case "no_subscription":
      return "You're on the free plan.";
    case "active":
      if (effective.willRenew && until) return `${planName} renews on ${until}.`;
      return until ? `${planName} is active until ${until} and won't renew.` : `${planName} is active.`;
    case "trial":
      return until ? `Your ${planName} trial ends on ${until}.` : `You're trying ${planName}.`;
    case "trial_ended":
      return `Your ${planName} trial has ended, so you're on the free plan.`;
    case "cancelled_until_period_end":
      // A grant arranged directly with Plenty isn't a cancellation; it just has an end date.
      if (effective.provider === "manual") return until ? `${planName} is included until ${until}.` : `${planName} is included.`;
      return until ? `${planName} is cancelled. You keep it until ${until}, and it won't renew.` : `${planName} is cancelled and won't renew.`;
    case "grace_period":
      return until
        ? `We couldn't take your latest payment. You still have ${planName} until ${until} while it's retried — please update your payment method.`
        : `We couldn't take your latest payment. Please update your payment method.`;
    case "payment_failed":
      return `We couldn't take your payment, so you're on the free plan for now. Updating your payment method restores ${planName}.`;
    case "paused":
      return `${planName} is paused, so you're on the free plan until you resume it.`;
    case "refunded":
      return `${planName} was refunded, so you're on the free plan.`;
    case "ended":
      return `${planName} has ended, so you're on the free plan.`;
    case "stale":
      return `We couldn't confirm your ${planName} renewal, so you're on the free plan for now. If you're still subscribed, restore your purchase.`;
  }
}
