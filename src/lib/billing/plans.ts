/**
 * Plans and entitlements — the one place that says what each plan includes.
 *
 * Everything the app gates goes through `entitlementsFor(plan)`; nothing else
 * should compare plan names. Subscriptions belong to the household, so these
 * limits apply to everyone in it.
 *
 * Two rules shape this file:
 *   - The free plan must genuinely solve the basic problem (what do we have,
 *     what are we low on, what do we need to buy), so it is never reduced to a
 *     teaser and nothing basic is withheld to push an upgrade.
 *   - Only advertise what exists. The `highlights` below are what the paywall,
 *     plan page and store listing show, and every line is a feature that is
 *     built in this version. Entitlement keys for things that aren't built yet
 *     (budgeting, price tracking, advanced automation) exist so the system is
 *     ready, but no launched plan grants them.
 */

export const PLAN_IDS = ["free", "plus", "family", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const BILLING_PERIODS = ["monthly", "annual"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

/** Which of the household's accounts of a feature a plan includes. */
export interface Entitlements {
  /** Everyone in the household, including profiles without an account. Null = no limit. */
  max_household_members: number | null;
  /** Active items in the kitchen. Null = no limit. */
  max_inventory_items: number | null;
  /** Receipt photos read per calendar month. Null = no limit. */
  receipt_scans_per_month: number | null;
  /** `basic` reads receipts on the device; `advanced` may also use AI vision (with the household's consent). */
  receipt_extraction: "basic" | "advanced";
  barcode_scanning: boolean;
  /** Photograph groceries and have Plenty suggest what it sees. */
  photo_recognition: boolean;
  /** Run-out predictions and "probably out in 3 days" estimates. History is always recorded. */
  consumption_predictions: boolean;
  /** Smart low-stock alerts and automatic shopping suggestions from predictions. */
  smart_replenishment: boolean;
  recurring_purchases: boolean;
  /** "What can I make?" from what's in the kitchen. All plans. */
  meal_planning: boolean;
  /** Weekly plans, swapping and regenerating, and turning a plan into shopping-list lines. */
  advanced_meal_planning: boolean;
  /** `basic`: label an item with who it's for. `full`: personal and private items with their own consumption patterns. */
  member_ownership: "basic" | "full";
  /** Spending, waste and household grocery analytics. */
  household_analytics: boolean;
  /** Email digests and the full notification controls. In-app expiry reminders are on every plan. */
  advanced_notifications: boolean;
  /** Purchase history: past receipts and what was bought when. */
  purchase_history: boolean;
  priority_support: boolean;
  // Not built yet: no launched plan grants these.
  budgeting: boolean;
  price_tracking: boolean;
  advanced_automation: boolean;
}

export type EntitlementKey = keyof Entitlements;

export const ENTITLEMENT_KEYS = [
  "max_household_members",
  "max_inventory_items",
  "receipt_scans_per_month",
  "receipt_extraction",
  "barcode_scanning",
  "photo_recognition",
  "consumption_predictions",
  "smart_replenishment",
  "recurring_purchases",
  "meal_planning",
  "advanced_meal_planning",
  "member_ownership",
  "household_analytics",
  "advanced_notifications",
  "purchase_history",
  "priority_support",
  "budgeting",
  "price_tracking",
  "advanced_automation",
] as const satisfies readonly EntitlementKey[];

const FREE: Entitlements = {
  max_household_members: 2,
  max_inventory_items: 50,
  receipt_scans_per_month: 5,
  receipt_extraction: "basic",
  barcode_scanning: false,
  photo_recognition: false,
  consumption_predictions: false,
  smart_replenishment: false,
  recurring_purchases: false,
  meal_planning: true,
  advanced_meal_planning: false,
  member_ownership: "basic",
  household_analytics: false,
  advanced_notifications: false,
  purchase_history: false,
  priority_support: false,
  budgeting: false,
  price_tracking: false,
  advanced_automation: false,
};

const PLUS: Entitlements = {
  ...FREE,
  max_household_members: 6,
  max_inventory_items: null,
  receipt_scans_per_month: null,
  receipt_extraction: "advanced",
  barcode_scanning: true,
  photo_recognition: true,
  consumption_predictions: true,
  smart_replenishment: true,
  recurring_purchases: true,
  advanced_meal_planning: true,
  advanced_notifications: true,
  purchase_history: true,
};

const FAMILY: Entitlements = {
  ...PLUS,
  max_household_members: 12,
  member_ownership: "full",
  household_analytics: true,
  priority_support: true,
};

/** Pro is defined but not offered: it launches only once the advanced features above exist. */
const PRO: Entitlements = {
  ...FAMILY,
  max_household_members: null,
};

const ENTITLEMENTS: Record<PlanId, Entitlements> = { free: FREE, plus: PLUS, family: FAMILY, pro: PRO };

export function entitlementsFor(plan: PlanId): Entitlements {
  return ENTITLEMENTS[plan];
}

/**
 * The switches the learning and shopping code needs, derived from a plan's
 * entitlements in one place so every caller agrees.
 */
export interface PlanFlags {
  /** Each person's own consumption pattern, not just the household's. */
  individualPatterns: boolean;
  /** Run-out predictions. History is recorded either way. */
  predictive: boolean;
  /** Plenty adds running-low and staple suggestions to the shopping list by itself. */
  smartShopping: boolean;
  /** A meal plan puts what it's missing on the shopping list. */
  mealPlanToList: boolean;
  /** Recurring purchases are added to the list when they come due. */
  recurringPurchases: boolean;
}

export function planFlags(e: Entitlements): PlanFlags {
  return {
    individualPatterns: e.member_ownership === "full",
    predictive: e.consumption_predictions,
    smartShopping: e.smart_replenishment,
    mealPlanToList: e.advanced_meal_planning,
    recurringPurchases: e.recurring_purchases,
  };
}

export interface PlanInfo {
  id: PlanId;
  name: string;
  tagline: string;
  /** Whether people can buy it today. */
  available: boolean;
  /** Prices in US dollars as listed on the paywall; the store or checkout shows the price for the person's region. */
  priceUsd: Record<BillingPeriod, number>;
  /** Features that exist in this version, in plain words. Never list anything that isn't built. */
  highlights: string[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  free: {
    id: "free",
    name: "Plenty Free",
    tagline: "Everything you need to keep track of one household.",
    available: true,
    priceUsd: { monthly: 0, annual: 0 },
    highlights: [
      "1 household, up to 2 people",
      "Up to 50 items in your kitchen, added by hand",
      "A shared shopping list with requests",
      "Assign items to household members",
      "5 receipt scans a month",
      "Expiry reminders",
      "Records what you finish, waste and buy",
      "“What can I make?” from what you have",
    ],
  },
  plus: {
    id: "plus",
    name: "Plenty Plus",
    tagline: "Plenty starts doing the grocery thinking for you.",
    available: true,
    priceUsd: { monthly: 4.99, annual: 49.99 },
    highlights: [
      "Everything in Free",
      "Up to 6 people",
      "Unlimited kitchen items and receipt scans",
      "AI-assisted receipt reading (with your permission)",
      "Barcode scanning and photo recognition",
      "Run-out predictions that explain themselves",
      "Smart low-stock alerts and automatic shopping suggestions",
      "Recurring purchases",
      "Weekly meal plans that turn into shopping lists",
      "Purchase history and email notifications",
    ],
  },
  family: {
    id: "family",
    name: "Plenty Family",
    tagline: "Understand the whole household, one person at a time.",
    available: true,
    priceUsd: { monthly: 8.99, annual: 89.99 },
    highlights: [
      "Everything in Plus",
      "Up to 12 people",
      "Food owned by individuals or the household, with private items",
      "Each person’s own consumption pattern",
      "Household grocery and waste analytics",
      "Priority support",
    ],
  },
  pro: {
    id: "pro",
    name: "Plenty Pro",
    tagline: "Not available yet.",
    available: false,
    priceUsd: { monthly: 14.99, annual: 149.99 },
    highlights: [],
  },
};

/** The plans people can buy, cheapest first. */
export const PURCHASABLE_PLANS: PlanId[] = PLAN_IDS.filter((id) => PLANS[id].available && id !== "free");

/**
 * Free trial offered with a first purchase. Zero means none is offered, and
 * nothing in the app says otherwise. If this is ever raised, the paywall,
 * store products and listing must change with it.
 */
export const TRIAL_DAYS = 0;

const RANK: Record<PlanId, number> = { free: 0, plus: 1, family: 2, pro: 3 };

export function planRank(plan: PlanId): number {
  return RANK[plan];
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return value === "monthly" || value === "annual";
}

/** The cheapest launched plan that grants a feature, for "Available on Plenty Plus"-style messages. */
export function cheapestPlanWith(predicate: (e: Entitlements) => boolean): PlanId | null {
  for (const id of PLAN_IDS) {
    if (PLANS[id].available && predicate(ENTITLEMENTS[id])) return id;
  }
  return null;
}

/** "$4.99 a month" / "$49.99 a year" */
export function formatPlanPrice(plan: PlanId, period: BillingPeriod): string {
  const price = PLANS[plan].priceUsd[period];
  if (price === 0) return "Free";
  return `$${price.toFixed(2)} a ${period === "monthly" ? "month" : "year"}`;
}

/** What the annual price saves compared with twelve months, e.g. "2 months free". */
export function annualSavings(plan: PlanId): { amountUsd: number; monthsFree: number } | null {
  const { monthly, annual } = PLANS[plan].priceUsd;
  if (!monthly || !annual) return null;
  const amountUsd = Math.round((monthly * 12 - annual) * 100) / 100;
  if (amountUsd <= 0) return null;
  return { amountUsd, monthsFree: Math.floor(amountUsd / monthly) };
}
