/**
 * Where a subscription is managed, by who sold it.
 *
 * A subscription bought through the App Store can only be changed or cancelled
 * in Apple's subscription settings, and one bought through Google Play only in
 * Google Play; web subscriptions are managed in Stripe's billing portal. The
 * plan page shows the path that actually applies, plainly, so cancelling is
 * never a hunt.
 */

import type { BillingProviderId } from "./subscription";

/** The in-app page that shows the plan. */
export const BILLING_PATH = "/settings/plan";

export type ManagementKind = "web_portal" | "app_store" | "google_play" | "operator";

export const PROVIDER_LABELS: Record<BillingProviderId, string> = {
  web: "the web",
  apple: "the App Store",
  google: "Google Play",
  manual: "Plenty",
};

export const APPLE_MANAGE_URL = "https://apps.apple.com/account/subscriptions";

export function googleManageUrl(productId?: string | null, packageName?: string | null): string {
  const base = "https://play.google.com/store/account/subscriptions";
  if (!productId || !packageName) return base;
  // Play product ids may carry a base plan ("product:basePlan"); the deep link takes the product id.
  const sku = productId.split(":")[0];
  return `${base}?sku=${encodeURIComponent(sku)}&package=${encodeURIComponent(packageName)}`;
}

export function managementKind(provider: BillingProviderId): ManagementKind {
  switch (provider) {
    case "web":
      return "web_portal";
    case "apple":
      return "app_store";
    case "google":
      return "google_play";
    case "manual":
      return "operator";
  }
}

/** "…update your payment method <where>." */
export function whereToManage(provider: BillingProviderId): string {
  switch (provider) {
    case "web":
      return "in Settings, then Plan";
    case "apple":
      return "in your Apple ID subscription settings";
    case "google":
      return "in Google Play under Payments & subscriptions";
    case "manual":
      return "with whoever arranged your plan";
  }
}

/** A date for messages, e.g. "10 October 2026". The year is always there: a plan that runs for a year shouldn't read as ending soon. Calendar dates in UTC so a message reads the same wherever it's opened. */
export function formatBillingDate(date: Date): string {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
