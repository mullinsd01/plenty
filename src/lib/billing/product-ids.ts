/**
 * Which store product (or Stripe price) is which plan and billing period.
 *
 * One small module, so renaming a product in App Store Connect, Google Play
 * Console or the Stripe dashboard is a settings change, never a code change.
 * Only the plans people can buy have products — Pro has none until it launches.
 *
 * Settings are written as `plan.period=product-id` pairs, for example
 * `plus.monthly=app.plenty.plus.monthly,plus.annual=app.plenty.plus.annual`.
 * Anything left out falls back to a documented default for the stores
 * (`app.plenty.<plan>.<period>`); Stripe price ids are account-specific, so
 * Stripe has no defaults and a price that isn't set simply can't be bought.
 */

import type { BillingPeriod } from "./plans";
import type { PaidPlanId } from "./events";

export const PRODUCT_KEYS = ["plus.monthly", "plus.annual", "family.monthly", "family.annual"] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];
export type ProductMap = Partial<Record<ProductKey, string>>;

export type ProductProvider = "web" | "apple" | "google";

/** The plans that have products. Mirrors PURCHASABLE_PLANS; Pro is deliberately absent. */
export const PRODUCT_PLANS = ["plus", "family"] as const satisfies readonly PaidPlanId[];

export function productKey(plan: PaidPlanId, period: BillingPeriod): ProductKey | null {
  const key = `${plan}.${period}`;
  return (PRODUCT_KEYS as readonly string[]).includes(key) ? (key as ProductKey) : null;
}

/** The ids the stores use unless a setting says otherwise. */
export const DEFAULT_STORE_PRODUCTS: Record<ProductKey, string> = {
  "plus.monthly": "app.plenty.plus.monthly",
  "plus.annual": "app.plenty.plus.annual",
  "family.monthly": "app.plenty.family.monthly",
  "family.annual": "app.plenty.family.annual",
};

/** Parse `plan.period=id,plan.period=id`. Unknown keys and malformed pairs are reported, never guessed at. */
export function parseProductMap(text: string | undefined | null): { map: ProductMap; problems: string[] } {
  const map: ProductMap = {};
  const problems: string[] = [];
  for (const raw of (text ?? "").split(/[,\n]/)) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      problems.push(`"${pair}" isn't plan.period=id`);
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!(PRODUCT_KEYS as readonly string[]).includes(key)) {
      problems.push(`"${key}" isn't one of ${PRODUCT_KEYS.join(", ")}`);
      continue;
    }
    map[key as ProductKey] = value;
  }
  return { map, problems };
}

/** The effective map for a provider: the stores' defaults overlaid with settings; Stripe has only what is set. */
export function resolveProducts(provider: ProductProvider, overrides: ProductMap | undefined): ProductMap {
  return provider === "web" ? { ...overrides } : { ...DEFAULT_STORE_PRODUCTS, ...overrides };
}

export function productIdFor(products: ProductMap, plan: PaidPlanId, period: BillingPeriod): string | null {
  const key = productKey(plan, period);
  return key ? (products[key] ?? null) : null;
}

/**
 * Which plan a product id means. An entry may name just the product
 * (`app.plenty.plus.monthly`) or a Google Play product with a base plan
 * (`app.plenty.plus:monthly`); the latter only matches when the base plan
 * does too.
 */
export function planForProductId(
  products: ProductMap,
  productId: string | null | undefined,
  basePlanId?: string | null,
): { plan: PaidPlanId; period: BillingPeriod } | null {
  if (!productId) return null;
  for (const key of PRODUCT_KEYS) {
    const configured = products[key];
    if (!configured) continue;
    const colon = configured.indexOf(":");
    const matches = colon === -1 ? configured === productId : basePlanId != null && configured === `${productId}:${basePlanId}`;
    if (matches) {
      const [plan, period] = key.split(".") as [PaidPlanId, BillingPeriod];
      return { plan, period };
    }
  }
  return null;
}
