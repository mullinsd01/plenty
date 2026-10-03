import { describe, expect, it } from "vitest";
import { formatBillingDate } from "@/lib/billing/management";
import { isPaywallFeature, PAYWALL_FEATURES, paywallPlanFor, parsePaywallFeature, planPageHref } from "@/lib/billing/paywall";
import { annualSavings, PLANS } from "@/lib/billing/plans";
import {
  buildComparison,
  monthlyResetDate,
  paymentAttentionText,
  planAction,
  planFacts,
  renewalFact,
  statusPill,
  storeDisclosure,
  usageRows,
  usageTone,
} from "@/lib/billing/plan-view";
import type { BillingOverview } from "@/server/billing/service";

const END = new Date(Date.UTC(2026, 9, 10));

/** A free household on the web, owner, with Stripe configured: the baseline each test bends. */
type OverviewInput = Omit<Partial<BillingOverview>, "purchase"> & { purchase?: Partial<BillingOverview["purchase"]> };

function overview(over: OverviewInput = {}): BillingOverview {
  const { purchase, ...rest } = over;
  const options = (["plus", "family"] as const).flatMap((plan) =>
    (["monthly", "annual"] as const).map((period) => ({ plan, planName: PLANS[plan].name, period, priceText: "", web: true })),
  );
  return {
    plan: "free",
    planName: "Plenty Free",
    subscribedPlan: null,
    reason: "no_subscription",
    summary: "You're on the free plan.",
    overridden: false,
    provider: null,
    period: null,
    willRenew: false,
    until: null,
    priceText: null,
    needsPaymentAttention: false,
    pendingChange: null,
    usage: {
      members: { used: 1, limit: 2 },
      items: { used: 10, limit: 50 },
      receiptScans: { used: 1, limit: 5, remaining: 4, period: "2026-10" },
    },
    overLimit: { over: false, limits: [], message: null },
    management: null,
    purchase: {
      platform: "web",
      canStartCheckout: true,
      blockedReason: null,
      options,
      providers: { web: true, apple: false, google: false },
      store: { provider: null, available: false, products: [] },
      trialDays: 0,
      ...purchase,
    },
    ...rest,
  };
}

const webSub = (over: Omit<Partial<BillingOverview>, "purchase"> = {}, purchase: Partial<BillingOverview["purchase"]> = {}) =>
  overview({
    plan: "plus",
    planName: "Plenty Plus",
    subscribedPlan: "plus",
    reason: "active",
    provider: "web",
    period: "annual",
    willRenew: true,
    until: END,
    priceText: "$49.99 a year",
    management: { kind: "web_portal", canManage: true, portal: true, url: null, label: "Manage billing", text: "Change it in the portal." },
    ...over,
    purchase: {
      canStartCheckout: false,
      blockedReason: "You already have a subscription. Use Manage billing to change plan or fix a payment.",
      ...purchase,
    } as BillingOverview["purchase"],
  });

describe("paywall features", () => {
  it("accepts only the analytics vocabulary", () => {
    for (const f of PAYWALL_FEATURES) expect(isPaywallFeature(f)).toBe(true);
    expect(parsePaywallFeature("photo")).toBe("photo");
    expect(parsePaywallFeature(["items", "photo"])).toBe("items");
    expect(parsePaywallFeature("nope")).toBeNull();
    expect(parsePaywallFeature(undefined)).toBeNull();
    expect(parsePaywallFeature("<script>")).toBeNull();
  });

  it("links to the plan page, remembering the feature", () => {
    expect(planPageHref()).toBe("/settings/plan");
    expect(planPageHref("barcode")).toBe("/settings/plan?from=barcode");
  });

  it("names the cheapest plan with the feature, never free or pro", () => {
    expect(paywallPlanFor("photo")).toBe("plus");
    expect(paywallPlanFor("items")).toBe("plus");
    expect(paywallPlanFor("ownership")).toBe("family");
    expect(paywallPlanFor("analytics")).toBe("family");
    for (const f of PAYWALL_FEATURES) expect(["plus", "family"]).toContain(paywallPlanFor(f));
  });
});

describe("usage", () => {
  it("is calm until the limit, then neutral amber, never an error", () => {
    expect(usageTone(1, 10)).toBe("ok");
    expect(usageTone(8, 10)).toBe("near");
    expect(usageTone(10, 10)).toBe("full");
    expect(usageTone(11, 10)).toBe("over");
    expect(usageTone(500, null)).toBe("ok");
  });

  it("says unlimited when there is no limit", () => {
    const rows = usageRows(
      overview({
        plan: "plus",
        usage: {
          members: { used: 3, limit: 6 },
          items: { used: 83, limit: null },
          receiptScans: { used: 0, limit: null, remaining: null, period: "2026-10" },
        },
      }),
    );
    expect(rows.map((r) => r.value)).toEqual(["3 of 6", "83 · unlimited", "0 · unlimited"]);
    expect(rows[1].fraction).toBeNull();
    expect(rows[2].note).toBeNull();
  });

  it("caps the meter at full when over, and says when scans reset", () => {
    const rows = usageRows(
      overview({
        usage: {
          members: { used: 8, limit: 2 },
          items: { used: 10, limit: 50 },
          receiptScans: { used: 5, limit: 5, remaining: 0, period: "2026-12" },
        },
      }),
    );
    expect(rows[0]).toMatchObject({ value: "8 of 2", fraction: 1, tone: "over" });
    expect(rows[2].note).toBe(`Resets on ${formatBillingDate(new Date(Date.UTC(2027, 0, 1)))}`);
  });

  it("works out the first of next month", () => {
    expect(monthlyResetDate("2026-10")?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(monthlyResetDate("2026-12")?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(monthlyResetDate("garbage")).toBeNull();
    expect(monthlyResetDate("2026-13")).toBeNull();
  });
});

describe("current plan facts", () => {
  it("labels each state plainly", () => {
    expect(statusPill(overview())).toEqual({ label: "Free", tone: "neutral" });
    expect(statusPill(webSub())).toEqual({ label: "Active", tone: "fresh" });
    expect(statusPill(webSub({ reason: "cancelled_until_period_end", willRenew: false }))).toEqual({ label: "Cancelled", tone: "soon" });
    expect(statusPill(webSub({ reason: "grace_period", needsPaymentAttention: true }))).toEqual({ label: "Payment needed", tone: "soon" });
    expect(statusPill(webSub({ plan: "free", reason: "paused", willRenew: false }))).toEqual({ label: "Paused", tone: "neutral" });
    expect(statusPill(overview({ provider: "manual", reason: "active", plan: "plus" })).label).toBe("Included");
    expect(statusPill(overview({ overridden: true, plan: "family" })).label).toBe("Set by this server");
  });

  it("only shows a date that matters now", () => {
    const d = formatBillingDate(END);
    expect(renewalFact(webSub())).toEqual({ label: "Renews on", value: d });
    expect(renewalFact(webSub({ willRenew: false }))).toEqual({ label: "Ends on", value: d });
    expect(renewalFact(webSub({ reason: "cancelled_until_period_end", willRenew: false }))).toEqual({ label: "Ends on", value: d });
    expect(renewalFact(webSub({ reason: "grace_period" }))).toEqual({ label: "Access until", value: d });
    expect(renewalFact(webSub({ reason: "refunded", plan: "free" }))).toBeNull();
    expect(renewalFact(overview())).toBeNull();
    expect(renewalFact(webSub({ overridden: true }))).toBeNull();
  });

  it("lists price, billing and date, leaving out what isn't there", () => {
    expect(planFacts(overview())).toEqual([]);
    expect(planFacts(webSub())).toEqual([
      { label: "Price", value: "$49.99 a year" },
      { label: "Billing", value: "Yearly · On the web" },
      { label: "Renews on", value: formatBillingDate(END) },
    ]);
    expect(planFacts(overview({ provider: "manual", reason: "active", plan: "plus" }))).toEqual([
      { label: "Billing", value: "Arranged with Plenty" },
    ]);
  });

  it("tells you where to fix a payment, in the place it was bought", () => {
    expect(paymentAttentionText(webSub({ reason: "grace_period" }))).toBe(
      "Update your payment method in the billing portal. You keep your plan while the payment is retried.",
    );
    expect(paymentAttentionText(webSub({ provider: "apple", reason: "grace_period", management: null }))).toContain(
      "Apple ID subscription settings",
    );
    expect(paymentAttentionText(webSub({ provider: "google", reason: "payment_failed", management: null }))).toBe(
      "Update your payment method in Google Play under Payments & subscriptions.",
    );
    expect(paymentAttentionText(webSub({ provider: "manual", management: null }))).toBe("Get in touch with whoever arranged your plan.");
  });
});

describe("what each plan card offers", () => {
  it("lets an owner of a free household subscribe, on the web only", () => {
    const o = overview();
    expect(planAction(o, "plus", "monthly")).toEqual({ kind: "checkout", plan: "plus", period: "monthly" });
    expect(planAction(o, "family", "annual")).toEqual({ kind: "checkout", plan: "family", period: "annual" });
    expect(planAction(o, "free", "monthly")).toEqual({ kind: "current" });
  });

  it("offers nothing when this server can't take payments", () => {
    const o = overview({ purchase: { canStartCheckout: false, providers: { web: false, apple: false, google: false } } });
    expect(planAction(o, "plus", "monthly")).toEqual({ kind: "none" });
  });

  it("gives a member the reason instead of a button", () => {
    const o = overview({ purchase: { canStartCheckout: false, blockedReason: "Only a household owner can change the plan." } });
    expect(planAction(o, "plus", "monthly")).toEqual({ kind: "text", text: "Only a household owner can change the plan." });
    expect(planAction(o, "free", "monthly")).toEqual({ kind: "current" });
  });

  it("sends a web subscriber to the billing portal for any change, including leaving", () => {
    const o = webSub();
    expect(planAction(o, "plus", "annual")).toEqual({ kind: "current" });
    expect(planAction(o, "family", "annual")).toEqual({ kind: "portal", label: "Change plan in billing portal" });
    expect(planAction(o, "free", "annual")).toEqual({ kind: "portal", label: "Change or cancel in billing portal" });
  });

  it("sends a store subscriber to the store's own settings", () => {
    const o = webSub({
      provider: "apple",
      management: {
        kind: "app_store",
        canManage: true,
        portal: false,
        url: "https://apps.apple.com/account/subscriptions",
        label: "Manage in Apple ID settings",
        text: "x",
      },
    });
    expect(planAction(o, "family", "monthly")).toEqual({
      kind: "store_link",
      url: "https://apps.apple.com/account/subscriptions",
      label: "Manage in Apple ID settings",
    });
  });

  it("explains a manual grant in words", () => {
    const o = webSub({
      provider: "manual",
      management: {
        kind: "operator",
        canManage: true,
        portal: false,
        url: null,
        label: "Plan details",
        text: "Arranged directly with Plenty.",
      },
    });
    expect(planAction(o, "family", "monthly")).toEqual({ kind: "text", text: "Arranged directly with Plenty." });
  });

  it("gives a non-owner the server's reason, not the owner's button", () => {
    const o = webSub(
      { management: { kind: "web_portal", canManage: false, portal: true, url: null, label: "Manage billing", text: "x" } },
      { blockedReason: "Only a household owner can change the plan." },
    );
    expect(planAction(o, "family", "monthly")).toEqual({ kind: "text", text: "Only a household owner can change the plan." });
  });

  it("shows a booked change on the plan it moves to", () => {
    const o = webSub({
      plan: "family",
      pendingChange: { plan: "plus", planName: "Plenty Plus", period: "annual", takesEffectOn: END, description: "x" },
    });
    expect(planAction(o, "plus", "monthly")).toEqual({ kind: "pending", text: `Starts on ${formatBillingDate(END)}` });
    expect(planAction(o, "family", "monthly")).toEqual({ kind: "current" });
  });

  it("shows the free plan as what a cancelled subscription becomes", () => {
    const o = webSub({ reason: "cancelled_until_period_end", willRenew: false });
    expect(planAction(o, "free", "monthly")).toEqual({ kind: "pending", text: `Starts on ${formatBillingDate(END)}` });
  });

  it("never offers anything when the server decides the plan", () => {
    const o = overview({ overridden: true, plan: "family" });
    expect(planAction(o, "plus", "monthly")).toEqual({ kind: "none" });
  });

  it("inside an app, buys through the store and never links to the web", () => {
    const store = {
      provider: "google" as const,
      available: true,
      products: [{ plan: "plus" as const, period: "monthly" as const, productId: "p", priceText: "$4.99 a month" }],
    };
    const o = overview({ purchase: { platform: "android", canStartCheckout: false, store } });
    expect(planAction(o, "plus", "monthly")).toEqual({ kind: "store" });
    expect(planAction(o, "plus", "annual")).toEqual({ kind: "none" });
    const web = webSub(
      {
        management: {
          kind: "web_portal",
          canManage: true,
          portal: false,
          url: null,
          label: "Managed on the web",
          text: "managed on the web",
        },
      },
      { platform: "android" },
    );
    expect(planAction(web, "family", "monthly")).toEqual({ kind: "text", text: "managed on the web" });
  });
});

describe("comparison", () => {
  it("is Free, Plus and Family, with Pro left out and described as not available", () => {
    const m = buildComparison(overview(), {});
    expect(m.cards.map((c) => c.id)).toEqual(["free", "plus", "family"]);
    expect(m.proNote).toBe("Plenty Pro isn't available yet.");
    expect(JSON.stringify(m)).not.toContain('Plenty Pro"');
  });

  it("takes feature text and prices from PLANS, and the real yearly saving", () => {
    const m = buildComparison(overview(), {});
    for (const c of m.cards) expect(c.highlights).toEqual(PLANS[c.id].highlights);
    const plus = m.cards[1];
    expect(plus.price.monthly).toMatchObject({ amount: "$4.99", per: "a month", saving: null });
    expect(plus.price.annual).toMatchObject({ amount: "$49.99", per: "a year" });
    expect(plus.price.annual?.saving).toBe(`Saves $${annualSavings("plus")!.amountUsd.toFixed(2)} a year compared with paying monthly`);
    expect(m.cards[0].price.monthly).toMatchObject({ amount: "Free", per: "" });
  });

  it("starts on monthly for a new buyer and on what you pay now for a subscriber", () => {
    expect(buildComparison(overview(), {}).defaultPeriod).toBe("monthly");
    expect(buildComparison(webSub(), {}).defaultPeriod).toBe("annual");
    expect(buildComparison(webSub({ plan: "free", reason: "ended", period: "annual" }), {}).defaultPeriod).toBe("annual");
    expect(buildComparison(overview({ period: "annual", reason: "no_subscription" }), {}).defaultPeriod).toBe("monthly");
  });

  it("shows the purchase terms only beside a button that starts a purchase", () => {
    const disclosures = { "plus.monthly": "Plenty Plus terms", "family.annual": "Plenty Family terms" };
    const m = buildComparison(overview(), disclosures);
    expect(m.cards[1].disclosure.monthly).toBe("Plenty Plus terms");
    expect(m.cards[2].disclosure.annual).toBe("Plenty Family terms");
    expect(m.cards[0].disclosure.monthly).toBeNull();
    const subscribed = buildComparison(webSub(), disclosures);
    for (const c of subscribed.cards) expect(c.disclosure).toEqual({ monthly: null, annual: null });
  });

  it("says why nothing can be bought, calmly, and hides prices that can't be paid", () => {
    const off = buildComparison(
      overview({ purchase: { canStartCheckout: false, providers: { web: false, apple: false, google: false }, options: [] } }),
      {},
    );
    expect(off.showPrices).toBe(false);
    expect(off.notice).toBe("Paid plans aren't available on this server yet. Plenty Free keeps working as usual.");
    expect(off.cards[1].price.monthly).toBeNull();
    const blocked = buildComparison(webSub(), {});
    expect(blocked.notice).toBe("You already have a subscription. Use Manage billing to change plan or fix a payment.");
    expect(buildComparison(overview({ overridden: true, plan: "family" }), {}).showPrices).toBe(false);
  });

  it("uses the store's terms inside an app, with no web checkout", () => {
    const store = {
      provider: "apple" as const,
      available: true,
      products: (["plus", "family"] as const).flatMap((plan) =>
        (["monthly", "annual"] as const).map((period) => ({ plan, period, productId: `${plan}.${period}`, priceText: "" })),
      ),
    };
    const m = buildComparison(overview({ purchase: { platform: "ios", canStartCheckout: false, store } }), {});
    expect(m.showPrices).toBe(true);
    expect(m.cards[1].actions.monthly).toEqual({ kind: "store" });
    expect(m.cards[1].disclosure.monthly).toBe(storeDisclosure("apple", "plus", "monthly"));
    expect(JSON.stringify(m)).not.toMatch(/portal|checkout/i);
    const noStore = buildComparison(overview({ purchase: { platform: "ios", canStartCheckout: false } }), {});
    expect(noStore.notice).toBe("Subscriptions in the app aren't available on this server yet. Plenty Free keeps working as usual.");
  });

  it("never promises a free trial while there isn't one", () => {
    const store = {
      provider: "google" as const,
      available: true,
      products: [{ plan: "plus" as const, period: "monthly" as const, productId: "x", priceText: "" }],
    };
    const text = JSON.stringify([
      buildComparison(overview(), {}),
      buildComparison(overview({ purchase: { platform: "android", store } }), {}),
    ]);
    expect(text).not.toMatch(/free trial|trial/i);
  });
});

describe("store terms", () => {
  it("state price, renewal, and where to cancel in the store's words", () => {
    expect(storeDisclosure("apple", "plus", "monthly")).toBe(
      "Plenty Plus: $4.99 a month. Billed by the App Store. It renews automatically each month until you cancel in your Apple ID subscription settings, and you keep Plenty Plus until the period you've paid for ends.",
    );
    expect(storeDisclosure("google", "family", "annual")).toContain("Billed by Google Play");
    expect(storeDisclosure("google", "family", "annual")).toContain("in Google Play under Payments & subscriptions");
  });
});
