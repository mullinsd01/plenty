/**
 * Where "this is part of a paid plan" notes send people, and what we may say
 * about the visit. The feature names are the `paywall_viewed` vocabulary in
 * `analytics-events.ts`, so nothing else can end up in analytics.
 */

import { ANALYTICS_PROPS } from "@/lib/analytics-events";
import { BILLING_PATH } from "./management";
import { cheapestPlanWith, entitlementsFor, type Entitlements, type PlanId } from "./plans";

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

/** Whether a limit (null = no limit) is higher than the one the household has now. */
const higher = (next: number | null, now: number | null): boolean => (next === null ? now !== null : now !== null && next > now);

/** What would lift the thing in the way, given what the household has now. */
const GRANTS: Record<PaywallFeature, (e: Entitlements, now: Entitlements) => boolean> = {
  items: (e, now) => higher(e.max_inventory_items, now.max_inventory_items),
  members: (e, now) => higher(e.max_household_members, now.max_household_members),
  receipts: (e, now) => higher(e.receipt_scans_per_month, now.receipt_scans_per_month),
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

/**
 * The cheapest plan that lifts what was in the way, as the `plan` of a `paywall_viewed` event: for a limit, the
 * next plan up from the household's current one (a Plus household that's full on people needs Family, not Plus).
 * Never free or Pro.
 */
export function paywallPlanFor(feature: PaywallFeature, current: PlanId = "free"): Extract<PlanId, "plus" | "family"> {
  const now = entitlementsFor(current);
  const plan = cheapestPlanWith((e) => GRANTS[feature](e, now));
  return plan === "family" ? "family" : "plus";
}
