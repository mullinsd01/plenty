import "server-only";
import { randomUUID } from "node:crypto";
import type { PaidPlanId } from "@/lib/billing/events";
import type { BillingPeriod } from "@/lib/billing/plans";
import { applyNormalizedEvent, type ApplyResult } from "../apply-event";

/**
 * Plans granted directly, not bought: for the demo household, a comped
 * household, or an operator fixing a support case.
 *
 * A grant is an ordinary subscription with the `manual` provider, so it flows
 * through the same state machine and shows up in the same audit trail. It never
 * replaces a subscription that is giving access through the web, the App Store
 * or Google Play (the result says `conflict`), and it is never counted as a
 * sale in analytics. There is nothing to configure, so it is always available —
 * but there is deliberately no web route to it: it is called from scripts and
 * admin tooling only.
 */

export const isConfigured = () => true;

const subscriptionIdFor = (householdId: string) => `manual:${householdId}`;

export interface GrantInput {
  householdId: string;
  plan: PaidPlanId;
  period?: BillingPeriod | null;
  /** When the grant ends. Null means it doesn't (the demo household). */
  until: Date | null;
  /** Why, for the audit trail. Short, and no personal details. */
  reason: string;
}

export function grantPlan(input: GrantInput, now = new Date()): Promise<ApplyResult> {
  return applyNormalizedEvent(
    {
      provider: "manual",
      eventId: `manual:grant:${randomUUID()}`,
      providerType: "grant",
      link: { providerSubscriptionId: subscriptionIdFor(input.householdId), householdId: input.householdId, householdVerified: true },
      event: { type: "started", occurredAt: now, provider: "manual", plan: input.plan, period: input.period ?? null, currentPeriodEnd: input.until, autoRenew: false },
      note: input.reason.slice(0, 200),
    },
    { now },
  );
}

/** End a granted plan now. Does nothing to a subscription that was bought. */
export function revokeGrant(householdId: string, reason: string, now = new Date()): Promise<ApplyResult> {
  return applyNormalizedEvent(
    {
      provider: "manual",
      eventId: `manual:revoke:${randomUUID()}`,
      providerType: "revoke",
      link: { providerSubscriptionId: subscriptionIdFor(householdId), householdId, householdVerified: true },
      event: { type: "cancelled_now", occurredAt: now },
      note: reason.slice(0, 200),
    },
    { now },
  );
}

/** The demo household explores everything the product offers, so it is given the top launched plan with no end. */
export function grantDemoPlan(householdId: string, now = new Date()): Promise<ApplyResult> {
  return grantPlan({ householdId, plan: "family", until: null, reason: "demo household" }, now);
}
