import { describe, expect, it } from "vitest";
import {
  annualSavings,
  BILLING_PERIODS,
  cheapestPlanWith,
  ENTITLEMENT_KEYS,
  entitlementsFor,
  formatPlanPrice,
  isBillingPeriod,
  isPlanId,
  PLAN_IDS,
  PLANS,
  planRank,
  PURCHASABLE_PLANS,
  TRIAL_DAYS,
  type Entitlements,
  type PlanId,
} from "@/lib/billing/plans";
import { overLimitReport } from "@/lib/billing/over-limit";
import {
  DEFAULT_STORE_PRODUCTS,
  parseProductMap,
  planForProductId,
  PRODUCT_KEYS,
  productIdFor,
  resolveProducts,
} from "@/lib/billing/product-ids";
import { formatBillingDate, googleManageUrl, managementKind, whereToManage } from "@/lib/billing/management";
import {
  describeEffectivePlan,
  RENEWAL_TOLERANCE_MS,
  resolveEffectivePlan,
  type EffectiveReason,
  type SubscriptionState,
} from "@/lib/billing/subscription";

const DAY = 86_400_000;
const T0 = new Date("2026-03-01T00:00:00Z").getTime();
const day = (n: number) => new Date(T0 + n * DAY);

describe("plans, prices and the paywall", () => {
  it("has the four plans, cheapest first", () => {
    expect(PLAN_IDS).toEqual(["free", "plus", "family", "pro"]);
    expect([...PLAN_IDS].sort((a, b) => planRank(a) - planRank(b))).toEqual([...PLAN_IDS]);
  });

  it("lists the prices exactly as specified", () => {
    expect(PLANS.free.priceUsd).toEqual({ monthly: 0, annual: 0 });
    expect(PLANS.plus.priceUsd).toEqual({ monthly: 4.99, annual: 49.99 });
    expect(PLANS.family.priceUsd).toEqual({ monthly: 8.99, annual: 89.99 });
    expect(PLANS.pro.priceUsd).toEqual({ monthly: 14.99, annual: 149.99 });
  });

  it("can only sell Plus and Family: Pro exists but is not purchasable, and nothing offers it", () => {
    expect(PLANS.pro.available).toBe(false);
    expect(PLANS.pro.highlights).toEqual([]);
    expect(PURCHASABLE_PLANS).toEqual(["plus", "family"]);
    expect(PURCHASABLE_PLANS).not.toContain("pro");
    expect(PURCHASABLE_PLANS).not.toContain("free");
    expect(cheapestPlanWith(() => true)).toBe("free");
    // No feature is ever advertised as "available on Pro".
    for (const key of ENTITLEMENT_KEYS) {
      const plan = cheapestPlanWith((e) => (typeof e[key] === "boolean" ? e[key] === true : e[key] !== entitlementsFor("free")[key]));
      expect(plan).not.toBe("pro");
    }
  });

  it("offers no free trial, and the model supports one", () => {
    expect(TRIAL_DAYS).toBe(0);
  });

  it("formats prices as the paywall shows them", () => {
    expect(formatPlanPrice("plus", "monthly")).toBe("$4.99 a month");
    expect(formatPlanPrice("plus", "annual")).toBe("$49.99 a year");
    expect(formatPlanPrice("family", "monthly")).toBe("$8.99 a month");
    expect(formatPlanPrice("family", "annual")).toBe("$89.99 a year");
    expect(formatPlanPrice("free", "monthly")).toBe("Free");
  });

  it("states the annual saving exactly, and never overclaims free months", () => {
    expect(annualSavings("plus")).toEqual({ amountUsd: 9.89, monthsFree: 1 });
    expect(annualSavings("family")).toEqual({ amountUsd: 17.89, monthsFree: 1 });
    expect(annualSavings("free")).toBeNull();
  });

  it("recognises plan ids and billing periods, and nothing else", () => {
    for (const id of PLAN_IDS) expect(isPlanId(id)).toBe(true);
    for (const bad of ["enterprise", "", null, undefined, 3, "PLUS"]) expect(isPlanId(bad)).toBe(false);
    for (const p of BILLING_PERIODS) expect(isBillingPeriod(p)).toBe(true);
    for (const bad of ["weekly", "", null, 12]) expect(isBillingPeriod(bad)).toBe(false);
  });

  it("only advertises features that exist: every highlight is plain text and free has no teaser-only claims", () => {
    for (const id of ["free", "plus", "family"] as const) {
      expect(PLANS[id].highlights.length).toBeGreaterThan(0);
      for (const line of PLANS[id].highlights) expect(line.trim()).toBe(line);
    }
    const everything = Object.values(PLANS).flatMap((p) => p.highlights).join(" ").toLowerCase();
    // Not built yet: must never be promised.
    for (const unbuilt of ["budget", "price tracking", "price track", "automation"]) expect(everything).not.toContain(unbuilt);
  });
});

describe("entitlements", () => {
  it("free is exactly what was promised", () => {
    const free = entitlementsFor("free");
    expect(free.max_household_members).toBe(2);
    expect(free.max_inventory_items).toBe(50);
    expect(free.receipt_scans_per_month).toBe(5);
    expect(free.receipt_extraction).toBe("basic");
    expect(free.member_ownership).toBe("basic");
    expect(free.meal_planning).toBe(true);
    expect(free.barcode_scanning).toBe(false);
    expect(free.photo_recognition).toBe(false);
    expect(free.consumption_predictions).toBe(false);
    expect(free.smart_replenishment).toBe(false);
    expect(free.recurring_purchases).toBe(false);
    expect(free.advanced_meal_planning).toBe(false);
    expect(free.household_analytics).toBe(false);
    expect(free.advanced_notifications).toBe(false);
    expect(free.purchase_history).toBe(false);
    expect(free.priority_support).toBe(false);
  });

  it("free genuinely solves the basic problem", () => {
    const free = entitlementsFor("free");
    // Something to track with, a way to read receipts, meals from what's in the kitchen, and assignment to people.
    expect(free.max_inventory_items).toBeGreaterThanOrEqual(50);
    expect(free.receipt_scans_per_month).toBeGreaterThan(0);
    expect(free.meal_planning).toBe(true);
    expect(free.max_household_members).toBeGreaterThanOrEqual(2);
  });

  it("Plus is exactly what was promised", () => {
    const plus = entitlementsFor("plus");
    expect(plus.max_household_members).toBe(6);
    expect(plus.max_inventory_items).toBeNull();
    expect(plus.receipt_scans_per_month).toBeNull();
    expect(plus.receipt_extraction).toBe("advanced");
    expect(plus.barcode_scanning).toBe(true);
    expect(plus.consumption_predictions).toBe(true);
    expect(plus.smart_replenishment).toBe(true);
    expect(plus.recurring_purchases).toBe(true);
    expect(plus.advanced_meal_planning).toBe(true);
    expect(plus.purchase_history).toBe(true);
    expect(plus.advanced_notifications).toBe(true);
    // Family-only.
    expect(plus.member_ownership).toBe("basic");
    expect(plus.household_analytics).toBe(false);
    expect(plus.priority_support).toBe(false);
  });

  it("Family is exactly what was promised", () => {
    const family = entitlementsFor("family");
    expect(family.max_household_members).toBe(12);
    expect(family.max_inventory_items).toBeNull();
    expect(family.receipt_scans_per_month).toBeNull();
    expect(family.member_ownership).toBe("full");
    expect(family.household_analytics).toBe(true);
    expect(family.priority_support).toBe(true);
    expect(family.consumption_predictions).toBe(true);
    expect(family.advanced_meal_planning).toBe(true);
  });

  it("Pro is defined above Family but unlimited people is the only thing it adds so far", () => {
    const pro = entitlementsFor("pro");
    expect(pro.max_household_members).toBeNull();
    expect({ ...pro, max_household_members: 12 }).toEqual(entitlementsFor("family"));
  });

  it("no launched plan grants a feature that isn't built", () => {
    for (const id of PLAN_IDS) {
      const e = entitlementsFor(id);
      expect(e.budgeting).toBe(false);
      expect(e.price_tracking).toBe(false);
      expect(e.advanced_automation).toBe(false);
    }
  });

  it("each plan includes everything the cheaper one does", () => {
    const rank = (v: Entitlements[keyof Entitlements]) => (v === null ? Number.POSITIVE_INFINITY : typeof v === "boolean" ? Number(v) : typeof v === "number" ? v : v === "advanced" || v === "full" ? 1 : 0);
    for (let i = 1; i < PLAN_IDS.length; i++) {
      const lower = entitlementsFor(PLAN_IDS[i - 1]);
      const higher = entitlementsFor(PLAN_IDS[i]);
      for (const key of ENTITLEMENT_KEYS) {
        expect(rank(higher[key]), `${PLAN_IDS[i]} should include ${key}`).toBeGreaterThanOrEqual(rank(lower[key]));
      }
    }
  });

  it("lists every entitlement key exactly once", () => {
    expect(new Set(ENTITLEMENT_KEYS).size).toBe(ENTITLEMENT_KEYS.length);
    expect([...ENTITLEMENT_KEYS].sort()).toEqual(Object.keys(entitlementsFor("free")).sort());
  });

  it("finds the cheapest plan that grants something, for upgrade messages", () => {
    expect(cheapestPlanWith((e) => e.barcode_scanning)).toBe("plus");
    expect(cheapestPlanWith((e) => e.member_ownership === "full")).toBe("family");
    expect(cheapestPlanWith((e) => e.priority_support)).toBe("family");
    expect(cheapestPlanWith((e) => e.budgeting)).toBeNull();
  });
});

describe("resolveEffectivePlan", () => {
  const base: SubscriptionState = {
    plan: "plus",
    period: "monthly",
    status: "active",
    provider: "web",
    autoRenew: true,
    currentPeriodEnd: day(30),
    trialEndsAt: null,
    graceEndsAt: null,
    pendingPlan: null,
    pendingPeriod: null,
  };
  const resolve = (over: Partial<SubscriptionState>, at: Date) => resolveEffectivePlan({ ...base, ...over }, at);

  it("no subscription, or one for the free plan, is the free plan", () => {
    expect(resolveEffectivePlan(null, day(0))).toMatchObject({ plan: "free", reason: "no_subscription", subscribedPlan: null, provider: null });
    expect(resolveEffectivePlan({ ...base, plan: "free" }, day(0))).toMatchObject({ plan: "free", reason: "no_subscription" });
  });

  it("active: the plan applies through the paid period", () => {
    expect(resolve({}, day(10))).toMatchObject({ plan: "plus", reason: "active", willRenew: true, until: day(30), needsPaymentAttention: false });
    expect(resolve({}, day(30))).toMatchObject({ plan: "plus", reason: "active" });
  });

  it("active: a late renewal confirmation doesn't cut off a paying household", () => {
    expect(RENEWAL_TOLERANCE_MS).toBe(3 * DAY);
    expect(resolve({}, new Date(day(30).getTime() + RENEWAL_TOLERANCE_MS))).toMatchObject({ plan: "plus", reason: "active" });
    expect(resolve({}, new Date(day(30).getTime() + RENEWAL_TOLERANCE_MS + 1))).toMatchObject({ plan: "free", reason: "stale", subscribedPlan: "plus" });
  });

  it("active but not renewing gets no tolerance: when it ends it ends", () => {
    expect(resolve({ autoRenew: false }, day(30))).toMatchObject({ plan: "plus", reason: "active", willRenew: false });
    expect(resolve({ autoRenew: false }, new Date(day(30).getTime() + 1))).toMatchObject({ plan: "free", reason: "ended" });
  });

  it("active with no end date (an operator grant) never lapses", () => {
    expect(resolve({ currentPeriodEnd: null, autoRenew: false }, day(5000)).plan).toBe("plus");
  });

  it("trialing: the plan applies until the trial ends", () => {
    const trial = { status: "trialing" as const, trialEndsAt: day(7), currentPeriodEnd: day(7) };
    expect(resolve(trial, day(3))).toMatchObject({ plan: "plus", reason: "trial", until: day(7) });
    expect(resolve(trial, day(7))).toMatchObject({ plan: "plus", reason: "trial" });
  });

  it("trialing: a trial that is converting isn't cut off by a late confirmation, and one that isn't converting is", () => {
    const trial = { status: "trialing" as const, trialEndsAt: day(7), currentPeriodEnd: day(7) };
    expect(resolve(trial, day(8))).toMatchObject({ plan: "plus", reason: "active", willRenew: true });
    expect(resolve(trial, day(11))).toMatchObject({ plan: "free", reason: "trial_ended" });
    expect(resolve({ ...trial, autoRenew: false }, day(8))).toMatchObject({ plan: "free", reason: "trial_ended" });
    expect(resolve({ ...trial, trialEndsAt: null }, day(1))).toMatchObject({ plan: "free", reason: "trial_ended" });
  });

  it("canceled: keeps what was paid for until the period ends", () => {
    const canceled = { status: "canceled" as const, autoRenew: false };
    expect(resolve(canceled, day(10))).toMatchObject({ plan: "plus", reason: "cancelled_until_period_end", willRenew: false });
    expect(resolve(canceled, new Date(day(30).getTime() + 1))).toMatchObject({ plan: "free", reason: "ended" });
    expect(resolve({ ...canceled, currentPeriodEnd: null }, day(10))).toMatchObject({ plan: "free", reason: "ended" });
  });

  it("past due: access continues through the grace period and says payment needs attention", () => {
    const failed = { status: "past_due" as const, currentPeriodEnd: day(30), graceEndsAt: day(37) };
    expect(resolve(failed, day(33))).toMatchObject({ plan: "plus", reason: "grace_period", needsPaymentAttention: true, until: day(37) });
    expect(resolve(failed, new Date(day(37).getTime() + 1))).toMatchObject({ plan: "free", reason: "payment_failed", needsPaymentAttention: true });
  });

  it("past due: time already paid for is never taken back early, and with nothing paid for there is no access", () => {
    const noGrace = { status: "past_due" as const, graceEndsAt: null };
    expect(resolve({ ...noGrace, currentPeriodEnd: day(30) }, day(20))).toMatchObject({ plan: "plus", reason: "grace_period" });
    expect(resolve({ ...noGrace, currentPeriodEnd: day(30) }, day(31))).toMatchObject({ plan: "free", reason: "payment_failed" });
    expect(resolve({ ...noGrace, currentPeriodEnd: null }, day(1))).toMatchObject({ plan: "free", reason: "payment_failed" });
  });

  it("paused, refunded and expired are the free plan", () => {
    expect(resolve({ status: "paused" }, day(1))).toMatchObject({ plan: "free", reason: "paused", subscribedPlan: "plus" });
    expect(resolve({ status: "refunded" }, day(1))).toMatchObject({ plan: "free", reason: "refunded" });
    expect(resolve({ status: "expired" }, day(1))).toMatchObject({ plan: "free", reason: "ended" });
  });

  it("never grants the plan after a refund, whatever the dates say", () => {
    expect(resolve({ status: "refunded", currentPeriodEnd: day(3000), autoRenew: true }, day(1)).plan).toBe("free");
  });

  it("reports a scheduled change and the provider, in force or not", () => {
    const pending = { plan: "family" as PlanId, pendingPlan: "plus" as PlanId, pendingPeriod: "monthly" as const, provider: "apple" as const };
    expect(resolve(pending, day(1))).toMatchObject({ plan: "family", pendingChange: { plan: "plus", period: "monthly" }, provider: "apple" });
    expect(resolve({ ...pending, status: "expired" }, day(1))).toMatchObject({ plan: "free", pendingChange: { plan: "plus", period: "monthly" } });
  });

  it("is deterministic: the same inputs give the same answer", () => {
    expect(resolve({}, day(5))).toEqual(resolve({}, day(5)));
  });
});

describe("describeEffectivePlan", () => {
  const text = (d: Date) => `${d.getUTCDate()} Mar`;
  const sentence = (reason: EffectiveReason, over: Partial<Parameters<typeof describeEffectivePlan>[0]> = {}) =>
    describeEffectivePlan({ plan: "plus", subscribedPlan: "plus", reason, willRenew: false, until: day(9), needsPaymentAttention: false, pendingChange: null, provider: "web", ...over }, "Plenty Plus", text);

  it("says the honest thing for every situation", () => {
    expect(sentence("no_subscription", { until: null })).toBe("You're on the free plan.");
    expect(sentence("active", { willRenew: true })).toBe("Plenty Plus renews on 10 Mar.");
    expect(sentence("active", { willRenew: false, until: null })).toBe("Plenty Plus is active.");
    expect(sentence("active", { willRenew: false })).toBe("Plenty Plus is active until 10 Mar and won't renew.");
    expect(sentence("trial")).toBe("Your Plenty Plus trial ends on 10 Mar.");
    expect(sentence("trial_ended")).toBe("Your Plenty Plus trial has ended, so you're on the free plan.");
    expect(sentence("cancelled_until_period_end")).toBe("Plenty Plus is cancelled. You keep it until 10 Mar, and it won't renew.");
    expect(sentence("grace_period")).toBe("We couldn't take your latest payment. You still have Plenty Plus until 10 Mar while it's retried — please update your payment method.");
    expect(sentence("payment_failed")).toBe("We couldn't take your payment, so you're on the free plan for now. Updating your payment method restores Plenty Plus.");
    expect(sentence("paused")).toBe("Plenty Plus is paused, so you're on the free plan until you resume it.");
    expect(sentence("refunded")).toBe("Plenty Plus was refunded, so you're on the free plan.");
    expect(sentence("ended")).toBe("Plenty Plus has ended, so you're on the free plan.");
    expect(sentence("stale")).toContain("restore your purchase");
  });

  it("describes an operator grant as included, not cancelled", () => {
    expect(sentence("cancelled_until_period_end", { provider: "manual" })).toBe("Plenty Plus is included until 10 Mar.");
    expect(sentence("cancelled_until_period_end", { provider: "manual", until: null })).toBe("Plenty Plus is included.");
  });

  it("is calm and never calls anything free that isn't", () => {
    const reasons: EffectiveReason[] = ["no_subscription", "active", "trial", "trial_ended", "cancelled_until_period_end", "grace_period", "payment_failed", "paused", "refunded", "ended", "stale"];
    for (const reason of reasons) {
      const s = sentence(reason, { willRenew: true });
      expect(s, reason).not.toMatch(/[!]|urgent|immediately|suspended|deleted|lose your/i);
      // "free" only ever appears for the free plan itself, never as an offer.
      expect(s, reason).not.toMatch(/free trial|try .* free|free for/i);
    }
  });

  it("works with a real resolved plan", () => {
    const eff = resolveEffectivePlan(
      { plan: "family", period: "annual", status: "canceled", provider: "google", autoRenew: false, currentPeriodEnd: day(9), trialEndsAt: null, graceEndsAt: null, pendingPlan: null, pendingPeriod: null },
      day(1),
    );
    expect(describeEffectivePlan(eff, PLANS.family.name, text)).toBe("Plenty Family is cancelled. You keep it until 10 Mar, and it won't renew.");
  });
});

describe("overLimitReport", () => {
  const free = entitlementsFor("free");

  it("reports nothing when under or exactly at the limits", () => {
    expect(overLimitReport(free, { members: 1, items: 10 })).toEqual({ over: false, limits: [], message: null });
    expect(overLimitReport(free, { members: 2, items: 50 }).over).toBe(false);
  });

  it("reports unlimited plans as never over", () => {
    expect(overLimitReport(entitlementsFor("plus"), { members: 6, items: 100_000 }).over).toBe(false);
    expect(overLimitReport(entitlementsFor("pro"), { members: 500, items: 100_000 }).over).toBe(false);
  });

  it("describes too many people after a downgrade, and says nobody is removed", () => {
    const report = overLimitReport(free, { members: 5, items: 10 });
    expect(report.over).toBe(true);
    expect(report.limits).toEqual([expect.objectContaining({ kind: "members", used: 5, limit: 2, over: 3 })]);
    expect(report.message).toContain("5 people");
    expect(report.message).toContain("covers 2");
    expect(report.message).toMatch(/nobody is removed or hidden/i);
  });

  it("describes too many items, and says nothing is deleted and finishing is always allowed", () => {
    const report = overLimitReport(free, { members: 1, items: 70 });
    expect(report.limits).toEqual([expect.objectContaining({ kind: "items", used: 70, limit: 50, over: 20 })]);
    expect(report.message).toMatch(/nothing is deleted or hidden/i);
    expect(report.message).toMatch(/finish or remove items any time/i);
  });

  it("reports both together, from Family down to Plus", () => {
    const report = overLimitReport(entitlementsFor("plus"), { members: 9, items: 500 });
    expect(report.limits.map((l) => l.kind)).toEqual(["members"]);
    const both = overLimitReport(free, { members: 3, items: 51 });
    expect(both.limits.map((l) => l.kind)).toEqual(["members", "items"]);
    expect(both.message).toContain("3 people");
    expect(both.message).toContain("51 items");
  });

  it("uses singular wording for one", () => {
    const report = overLimitReport({ max_household_members: 0, max_inventory_items: 0 }, { members: 1, items: 1 });
    expect(report.message).toContain("1 person");
    expect(report.message).toContain("1 item ");
  });
});

describe("products and prices", () => {
  it("has a sensible documented default for each store product, and none for Stripe", () => {
    expect(DEFAULT_STORE_PRODUCTS).toEqual({
      "plus.monthly": "app.plenty.plus.monthly",
      "plus.annual": "app.plenty.plus.annual",
      "family.monthly": "app.plenty.family.monthly",
      "family.annual": "app.plenty.family.annual",
    });
    expect(resolveProducts("apple", undefined)).toEqual(DEFAULT_STORE_PRODUCTS);
    expect(resolveProducts("google", undefined)).toEqual(DEFAULT_STORE_PRODUCTS);
    expect(resolveProducts("web", undefined)).toEqual({});
  });

  it("never has a product for Pro or the free plan", () => {
    expect(PRODUCT_KEYS.some((k) => k.startsWith("pro") || k.startsWith("free"))).toBe(false);
    expect(productIdFor(DEFAULT_STORE_PRODUCTS, "pro", "monthly")).toBeNull();
  });

  it("parses settings and overrides only what is named", () => {
    const { map, problems } = parseProductMap("plus.monthly=price_abc, family.annual = price_xyz\nplus.annual=price_def");
    expect(problems).toEqual([]);
    expect(map).toEqual({ "plus.monthly": "price_abc", "family.annual": "price_xyz", "plus.annual": "price_def" });
    expect(resolveProducts("apple", map)["plus.monthly"]).toBe("price_abc");
    expect(resolveProducts("apple", map)["family.monthly"]).toBe("app.plenty.family.monthly");
  });

  it("reports malformed settings instead of guessing", () => {
    const { map, problems } = parseProductMap("plus.monthly,pro.monthly=price_1,plus.weekly=x,=y,family.annual=");
    expect(map).toEqual({});
    expect(problems).toHaveLength(5);
    expect(parseProductMap(undefined)).toEqual({ map: {}, problems: [] });
    expect(parseProductMap("")).toEqual({ map: {}, problems: [] });
  });

  it("maps a product id back to its plan and period", () => {
    expect(planForProductId(DEFAULT_STORE_PRODUCTS, "app.plenty.family.annual")).toEqual({ plan: "family", period: "annual" });
    expect(planForProductId(DEFAULT_STORE_PRODUCTS, "app.plenty.plus.monthly")).toEqual({ plan: "plus", period: "monthly" });
    expect(planForProductId(DEFAULT_STORE_PRODUCTS, "app.plenty.pro.monthly")).toBeNull();
    expect(planForProductId(DEFAULT_STORE_PRODUCTS, "something.else")).toBeNull();
    expect(planForProductId(DEFAULT_STORE_PRODUCTS, null)).toBeNull();
  });

  it("matches a Google product with a base plan only when the base plan matches too", () => {
    const products = { "plus.monthly": "app.plenty.plus:monthly", "plus.annual": "app.plenty.plus:annual" };
    expect(planForProductId(products, "app.plenty.plus", "monthly")).toEqual({ plan: "plus", period: "monthly" });
    expect(planForProductId(products, "app.plenty.plus", "annual")).toEqual({ plan: "plus", period: "annual" });
    expect(planForProductId(products, "app.plenty.plus", "weekly")).toBeNull();
    expect(planForProductId(products, "app.plenty.plus")).toBeNull();
    expect(productIdFor(products, "plus", "annual")).toBe("app.plenty.plus:annual");
  });
});

describe("where a subscription is managed", () => {
  it("points each provider at its own management path", () => {
    expect(managementKind("web")).toBe("web_portal");
    expect(managementKind("apple")).toBe("app_store");
    expect(managementKind("google")).toBe("google_play");
    expect(managementKind("manual")).toBe("operator");
    expect(whereToManage("apple")).toContain("Apple ID");
    expect(whereToManage("google")).toContain("Google Play");
    expect(whereToManage("web")).toContain("Settings");
  });

  it("builds the Google Play deep link, using the product id without any base plan", () => {
    expect(googleManageUrl()).toBe("https://play.google.com/store/account/subscriptions");
    expect(googleManageUrl("app.plenty.plus:monthly", "app.plenty")).toBe("https://play.google.com/store/account/subscriptions?sku=app.plenty.plus&package=app.plenty");
  });

  it("formats dates in UTC so a message reads the same everywhere", () => {
    expect(formatBillingDate(new Date("2026-10-10T23:30:00Z"))).toBe("10 October 2026");
  });
});
