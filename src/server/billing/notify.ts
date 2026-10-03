import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import type { PlanId } from "@/lib/billing/plans";
import { PLANS } from "@/lib/billing/plans";
import { BILLING_PATH, formatBillingDate, PROVIDER_LABELS, whereToManage } from "@/lib/billing/management";
import type { BillingProviderId } from "@/lib/billing/subscription";
import type { Queryable } from "@/server/db/client";
import { householdMembers, notifications } from "@/server/db/schema";

/**
 * Billing notices for household owners. They are plain and calm: say what
 * happened, what it means for the household right now, and what to do. They
 * never include payment details and nothing in them is a threat.
 */

export interface BillingNotice {
  title: string;
  body: string;
  link: string;
  dedupeKey: string;
}

/** A renewal payment failed. `graceEndsAt` is set when access continues for now. */
export function paymentFailedNotice(args: { plan: PlanId; provider: BillingProviderId; graceEndsAt: Date | null; periodKey: string; now: Date }): BillingNotice {
  const name = PLANS[args.plan].name;
  const where = whereToManage(args.provider);
  const stillHasAccess = args.graceEndsAt !== null && args.graceEndsAt.getTime() > args.now.getTime();
  return {
    title: "We couldn't take your payment",
    body: stillHasAccess
      ? `We couldn't take the latest payment for ${name}. You still have it until ${formatBillingDate(args.graceEndsAt!)} while it's tried again. To keep it, update your payment method ${where}.`
      : `We couldn't take the latest payment for ${name}, so your household is on the free plan for now. Nothing you've saved has been removed. Updating your payment method ${where} brings ${name} back.`,
    link: BILLING_PATH,
    dedupeKey: `billing:payment_failed:${args.periodKey}`,
  };
}

/** A second subscription was started while one is already active. */
export function duplicateSubscriptionNotice(args: { plan: PlanId; existing: BillingProviderId; incoming: BillingProviderId; incomingKey: string }): BillingNotice {
  const name = PLANS[args.plan].name;
  return {
    title: "You may have paid twice",
    body: `Your household already has ${name} through ${PROVIDER_LABELS[args.existing]}, and a second subscription was just started through ${PROVIDER_LABELS[args.incoming]}. Only one can be used, so the new one isn't being applied. To avoid paying twice, cancel one of them ${whereToManage(args.incoming)}, or contact support and we'll sort it out.`,
    link: BILLING_PATH,
    dedupeKey: `billing:duplicate:${args.incomingKey}`,
  };
}

/** Tell every household owner who has an account. Safe to repeat: the dedupe key makes a second send do nothing. */
export async function notifyOwners(db: Queryable, householdId: string, notice: BillingNotice): Promise<void> {
  const owners = await db
    .select({ userId: householdMembers.userId })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.role, "owner"), isNotNull(householdMembers.userId)));
  for (const owner of owners) {
    if (!owner.userId) continue;
    await db
      .insert(notifications)
      .values({ householdId, userId: owner.userId, type: "billing", ...notice })
      .onConflictDoNothing();
  }
}
