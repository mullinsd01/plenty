/**
 * Where "this is part of a paid plan" notes send people, and what we may say
 * about the visit. The feature names are the `paywall_viewed` vocabulary in
 * `analytics-events.ts`, so nothing else can end up in analytics.
 */

import { ANALYTICS_PROPS } from "@/lib/analytics-events";
import { BILLING_PATH } from "./management";
import { cheapestPlanWith, type Entitlements, type PlanId } from "./plans";

export type PaywallFeature = (typeof ANALYTICS_PROPS.paywall_viewed.feature)[number];
export const PAYWALL_FEATURES: readonly PaywallFeature[] = ANALYTICS_PROPS.paywall_viewed.feature;

export function isPaywallFeature(value: unknown): value is PaywallFeature {
  return typeof value === "string" && (PAYWALL_FEATURES as readonly string[]).includes(value);
}

/** A feature name from a query string (`?from=`), or null when it isn't one of ours. */
export function parsePaywallFeature(value: string | string[] | null | undefined): PaywallFeature | null {
  const one = Array.isArray(value) ? value[0] : value;
  return isPaywallFeature(one) ? one : null;
}

/** The plan page, remembering which feature sent the person there. */
export function planPageHref(feature?: PaywallFeature | null): string {
  return feature ? `${BILLING_PATH}?from=${feature}` : BILLING_PATH;
}

const GRANTS: Record<PaywallFeature, (e: Entitlements) => boolean> = {
  items: (e) => e.max_inventory_items === null,
  members: (e) => e.max_household_members !== null && e.max_household_members > 2,
  receipts: (e) => e.receipt_scans_per_month === null,
  barcode: (e) => e.barcode_scanning,
  photo: (e) => e.photo_recognition,
  predictions: (e) => e.consumption_predictions,
  replenishment: (e) => e.smart_replenishment,
  recurring: (e) => e.recurring_purchases,
  meal_planning: (e) => e.advanced_meal_planning,
  ownership: (e) => e.member_ownership === "full",
  analytics: (e) => e.household_analytics,
  plans: (e) => e.max_inventory_items === null,
};

/** The cheapest plan that includes a feature, as the `plan` of a `paywall_viewed` event. Never free or Pro. */
export function paywallPlanFor(feature: PaywallFeature): Extract<PlanId, "plus" | "family"> {
  const plan = cheapestPlanWith(GRANTS[feature]);
  return plan === "family" ? "family" : "plus";
}
