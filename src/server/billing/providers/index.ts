import "server-only";
import { PURCHASABLE_PLANS, BILLING_PERIODS, type BillingPeriod } from "@/lib/billing/plans";
import type { PaidPlanId } from "@/lib/billing/events";
import * as apple from "./apple";
import * as google from "./google";
import * as stripe from "./stripe";

/**
 * Which ways of paying this server can actually offer. A provider with missing
 * settings is simply absent: its routes answer 503 and the UI never shows it.
 * Apple and Google are listed for restoring and managing; buying through them
 * happens in the native apps, with the stores' own purchase sheets.
 */
export interface ProviderAvailability {
  web: boolean;
  apple: boolean;
  google: boolean;
}

export function availableProviders(): ProviderAvailability {
  return { web: stripe.isConfigured(), apple: apple.isConfigured(), google: google.isConfigured() };
}

/** The plan and period combinations that can be bought on the web right now. */
export function webOffers(): Array<{ plan: PaidPlanId; period: BillingPeriod }> {
  const config = stripe.readStripeConfig();
  if (!config) return [];
  const offers: Array<{ plan: PaidPlanId; period: BillingPeriod }> = [];
  for (const plan of PURCHASABLE_PLANS) {
    if (plan === "free" || plan === "pro") continue;
    for (const period of BILLING_PERIODS) if (stripe.canSell(plan, period, config)) offers.push({ plan, period });
  }
  return offers;
}
