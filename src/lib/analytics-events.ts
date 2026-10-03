/**
 * The only analytics events Plenty records, and the only properties each may
 * carry. Names and receipts never appear: properties are short, fixed
 * vocabularies and counts, so nothing about a person or what they buy can end
 * up in analytics by accident.
 */

export const ANALYTICS_EVENTS = [
  "item_added",
  "receipt_scanned",
  "receipt_confirmed",
  "item_consumed",
  "item_added_to_shopping_list",
  "shopping_item_completed",
  "prediction_shown",
  "prediction_accepted",
  "prediction_rejected",
  "meal_suggested",
  "meal_selected",
  "paywall_viewed",
  "subscription_started",
  "subscription_cancelled",
] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** Allowed property names per event, each with the values it may take. A number means "any non-negative integer up to a cap". */
export const ANALYTICS_PROPS = {
  item_added: { source: ["manual", "receipt", "barcode", "photo", "shopping_list"], owned: ["household", "member", "private"], count: 500 },
  receipt_scanned: { provider: ["local", "anthropic"], outcome: ["read", "failed", "duplicate"] },
  receipt_confirmed: { lines: 500, corrected: 500 },
  item_consumed: { outcome: ["consumed", "wasted", "expired"] },
  item_added_to_shopping_list: { source: ["manual", "predicted", "meal_plan", "staple", "request", "recurring"] },
  shopping_item_completed: { source: ["manual", "predicted", "meal_plan", "staple", "request", "recurring"] },
  prediction_shown: { basis: ["estimate", "history"], confidence: ["low", "medium", "high"] },
  prediction_accepted: { basis: ["estimate", "history"] },
  prediction_rejected: { basis: ["estimate", "history"] },
  meal_suggested: { surface: ["plan", "cook_now", "use_soon"] },
  meal_selected: { surface: ["plan", "cook_now", "use_soon"] },
  paywall_viewed: { feature: ["items", "members", "receipts", "barcode", "photo", "predictions", "replenishment", "recurring", "meal_planning", "ownership", "analytics", "plans"], plan: ["plus", "family"] },
  subscription_started: { plan: ["plus", "family"], period: ["monthly", "annual"], provider: ["web", "apple", "google"] },
  subscription_cancelled: { plan: ["plus", "family"], provider: ["web", "apple", "google"] },
} as const satisfies Record<AnalyticsEvent, Record<string, readonly string[] | number>>;

export type AnalyticsProps = Record<string, string | number>;

/** Keep only allowed properties with allowed values; anything else is dropped, never recorded. */
export function sanitizeAnalyticsProps(event: AnalyticsEvent, props: AnalyticsProps | undefined): AnalyticsProps {
  const allowed = ANALYTICS_PROPS[event] as Record<string, readonly string[] | number>;
  const out: AnalyticsProps = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    const rule = allowed[key];
    if (rule === undefined) continue;
    if (typeof rule === "number") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.min(Math.floor(value), rule);
    } else if (typeof value === "string" && rule.includes(value)) {
      out[key] = value;
    }
  }
  return out;
}

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  return typeof value === "string" && (ANALYTICS_EVENTS as readonly string[]).includes(value);
}
