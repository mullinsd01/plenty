/**
 * What the plan page shows, worked out from a `BillingOverview` in pure
 * functions so each state can be tested without rendering anything.
 *
 * Wording that comes from the server (`summary`, `pendingChange.description`,
 * `management.text`, `overLimit.message`, `purchase.blockedReason`) is passed
 * through as given. What is built here is only layout decisions and short
 * labels. Feature text and prices come from `PLANS`, never from this file.
 */

import type { BillingOverview } from "@/server/billing/service";
import { formatBillingDate, whereToManage } from "./management";
import { isNativePlatform, type ClientPlatform } from "./platform";
import { annualSavings, BILLING_PERIODS, formatPlanPrice, PLANS, type BillingPeriod, type PlanId } from "./plans";

// ─── Current plan ───────────────────────────────────────────────────────────

export type PillTone = "neutral" | "brand" | "fresh" | "soon" | "alert" | "info" | "outline";

/** The short status next to the plan name. */
export function statusPill(o: BillingOverview): { label: string; tone: PillTone } {
  if (o.overridden) return { label: "Set by this server", tone: "neutral" };
  switch (o.reason) {
    case "no_subscription":
      return { label: "Free", tone: "neutral" };
    case "active":
      if (o.provider === "manual") return { label: "Included", tone: "info" };
      return o.willRenew ? { label: "Active", tone: "fresh" } : { label: "Won't renew", tone: "soon" };
    case "trial":
      return { label: "Trial", tone: "info" };
    case "cancelled_until_period_end":
      return o.provider === "manual" ? { label: "Included", tone: "info" } : { label: "Cancelled", tone: "soon" };
    case "grace_period":
    case "payment_failed":
      return { label: "Payment needed", tone: "soon" };
    case "paused":
      return { label: "Paused", tone: "neutral" };
    case "trial_ended":
    case "refunded":
    case "ended":
    case "stale":
      return { label: "Free plan", tone: "neutral" };
  }
}

/** "Renews on 12 October" as a label and a date, only when the plan has a date that matters now. */
export function renewalFact(o: BillingOverview): { label: string; value: string } | null {
  if (!o.until || o.overridden) return null;
  const value = formatBillingDate(o.until);
  switch (o.reason) {
    case "active":
      return { label: o.willRenew ? "Renews on" : "Ends on", value };
    case "cancelled_until_period_end":
      return { label: o.provider === "manual" ? "Included until" : "Ends on", value };
    case "grace_period":
      return { label: "Access until", value };
    case "trial":
      return { label: "Trial ends on", value };
    default:
      return null;
  }
}

const PROVIDER_BILLED_BY = { web: "On the web", apple: "App Store", google: "Google Play", manual: "Arranged with Plenty" } as const;

/** The facts under the summary: price, how often, who bills, and the date. Empty rows are left out. */
export function planFacts(o: BillingOverview): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  if (o.priceText) facts.push({ label: "Price", value: o.priceText });
  if (o.provider && o.provider !== "manual" && o.period && o.reason !== "no_subscription") {
    facts.push({ label: "Billing", value: `${o.period === "monthly" ? "Monthly" : "Yearly"} · ${PROVIDER_BILLED_BY[o.provider]}` });
  } else if (o.provider === "manual") {
    facts.push({ label: "Billing", value: PROVIDER_BILLED_BY.manual });
  }
  const renewal = renewalFact(o);
  if (renewal) facts.push(renewal);
  return facts;
}

/** Why the payment banner is showing and where to fix it, in the words of the place the subscription lives. */
export function paymentAttentionText(o: BillingOverview): string {
  const where =
    o.provider === "web" && o.management?.portal
      ? "in the billing portal"
      : o.provider
        ? whereToManage(o.provider)
        : "in your plan settings";
  return o.provider === "manual"
    ? "Get in touch with whoever arranged your plan."
    : `Update your payment method ${where}.${o.reason === "grace_period" ? " You keep your plan while the payment is retried." : ""}`;
}

// ─── Usage ──────────────────────────────────────────────────────────────────

export type UsageTone = "ok" | "near" | "full" | "over";

export interface UsageRow {
  key: "members" | "items" | "receiptScans";
  label: string;
  used: number;
  limit: number | null;
  /** "34 of 50", or "12 · unlimited". */
  value: string;
  /** 0 to 1; null when there's no limit to measure against. */
  fraction: number | null;
  tone: UsageTone;
  note: string | null;
}

export function usageTone(used: number, limit: number | null): UsageTone {
  if (limit === null || limit <= 0) return "ok";
  if (used > limit) return "over";
  if (used === limit) return "full";
  return used / limit >= 0.8 ? "near" : "ok";
}

/** The first day of the month after a "YYYY-MM" usage period, which is when the receipt allowance resets. */
export function monthlyResetDate(period: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(Number(m[1]), month, 1));
}

function usageRow(key: UsageRow["key"], label: string, used: number, limit: number | null, note: string | null): UsageRow {
  const tone = usageTone(used, limit);
  return {
    key,
    label,
    used,
    limit,
    value: limit === null ? `${used} · unlimited` : `${used} of ${limit}`,
    fraction: limit === null || limit <= 0 ? null : Math.min(1, used / limit),
    tone,
    note,
  };
}

export function usageRows(o: BillingOverview): UsageRow[] {
  const { members, items, receiptScans } = o.usage;
  const reset = monthlyResetDate(receiptScans.period);
  const resetNote = receiptScans.limit !== null && reset ? `Resets on ${formatBillingDate(reset)}` : null;
  return [
    usageRow("members", "People", members.used, members.limit, null),
    usageRow("items", "Kitchen items", items.used, items.limit, null),
    usageRow("receiptScans", "Receipt scans this month", receiptScans.used, receiptScans.limit, resetNote),
  ];
}

// ─── Plan comparison ────────────────────────────────────────────────────────

export const COMPARED_PLANS = ["free", "plus", "family"] as const;
export type ComparedPlan = (typeof COMPARED_PLANS)[number];

export type PlanAction =
  | { kind: "current" }
  /** A change already booked to start here. */
  | { kind: "pending"; text: string }
  /** Start a web subscription. */
  | { kind: "checkout"; plan: "plus" | "family"; period: BillingPeriod }
  /** Change it in the web billing portal. */
  | { kind: "portal"; label: string }
  /** Change it in the store's own subscription settings. */
  | { kind: "store_link"; url: string; label: string }
  /** Bought through the platform's purchase sheet, which the app opens. Nothing to click here. */
  | { kind: "store" }
  /** Nothing to click; a plain explanation. */
  | { kind: "text"; text: string }
  | { kind: "none" };

const NAME_WITHOUT_BRAND = (plan: PlanId) => PLANS[plan].name.replace(/^Plenty /, "");

/**
 * What a plan's card offers, honestly: buying when there is no subscription,
 * changing through the place the subscription was bought when there is one,
 * and never anything the platform or the person's role doesn't allow.
 */
export function planAction(o: BillingOverview, target: ComparedPlan, period: BillingPeriod): PlanAction {
  if (target === o.plan) return { kind: "current" };

  if (o.pendingChange?.plan === target) {
    return {
      kind: "pending",
      text: o.pendingChange.takesEffectOn ? `Starts on ${formatBillingDate(o.pendingChange.takesEffectOn)}` : "Starts at the next renewal",
    };
  }
  // A subscription that won't renew ends in the free plan. Say so on that card instead of offering a button.
  if (target === "free" && !o.willRenew && o.until && (o.reason === "active" || o.reason === "cancelled_until_period_end")) {
    return { kind: "pending", text: `Starts on ${formatBillingDate(o.until)}` };
  }

  if (o.overridden) return { kind: "none" };

  const m = o.management;
  const native = isNativePlatform(o.purchase.platform);

  // Not allowed to change it, or already subscribed (or in trouble with a subscription): the server says why.
  if (o.purchase.blockedReason !== null) {
    if (!m) return target === "free" ? { kind: "none" } : { kind: "text", text: o.purchase.blockedReason };
    if (!m.canManage) return { kind: "text", text: o.purchase.blockedReason };
    const label = target === "free" ? "Change or cancel" : "Change plan";
    if (m.portal) return { kind: "portal", label: `${label} in billing portal` };
    if (m.url) return { kind: "store_link", url: m.url, label: m.label };
    return { kind: "text", text: m.text };
  }

  if (target === "free") return { kind: "none" };

  if (native) {
    return o.purchase.store.available && o.purchase.store.products.some((p) => p.plan === target && p.period === period)
      ? { kind: "store" }
      : { kind: "none" };
  }
  if (o.purchase.canStartCheckout && o.purchase.options.some((opt) => opt.plan === target && opt.period === period && opt.web)) {
    return { kind: "checkout", plan: target, period };
  }
  return { kind: "none" };
}

export interface PlanCardModel {
  id: ComparedPlan;
  name: string;
  tagline: string;
  highlights: string[];
  current: boolean;
  /** Price per period, or null when prices aren't shown. */
  price: Record<BillingPeriod, { amount: string; per: string; saving: string | null } | null>;
  actions: Record<BillingPeriod, PlanAction>;
  disclosure: Record<BillingPeriod, string | null>;
  /** Short name for buttons: "Plus". */
  shortName: string;
}

export interface ComparisonModel {
  platform: ClientPlatform;
  /** Whether prices and the monthly / yearly switch are shown. */
  showPrices: boolean;
  /** The period the switch starts on: what the household pays now, else monthly. Never a nudge towards yearly. */
  defaultPeriod: BillingPeriod;
  /** One calm sentence above the plans: why nothing can be bought here, when that's so. */
  notice: string | null;
  cards: PlanCardModel[];
  /** What a smaller plan never does. */
  keepNote: string;
  proNote: string;
}

function money(plan: PlanId, period: BillingPeriod): { amount: string; per: string } {
  const price = PLANS[plan].priceUsd[period];
  return { amount: price === 0 ? "Free" : `$${price.toFixed(2)}`, per: price === 0 ? "" : period === "monthly" ? "a month" : "a year" };
}

function savingText(plan: PlanId): string | null {
  const saving = annualSavings(plan);
  return saving ? `Saves $${saving.amountUsd.toFixed(2)} a year compared with paying monthly` : null;
}

/** The text next to a store purchase: price, renewal, and where to cancel, in the store's own terms. */
export function storeDisclosure(provider: "apple" | "google", plan: "plus" | "family", period: BillingPeriod): string {
  const name = PLANS[plan].name;
  const every = period === "monthly" ? "month" : "year";
  const store = provider === "apple" ? "the App Store" : "Google Play";
  return `${name}: ${formatPlanPrice(plan, period)}. Billed by ${store}. It renews automatically each ${every} until you cancel ${whereToManage(provider)}, and you keep ${name} until the period you've paid for ends.`;
}

export function buildComparison(o: BillingOverview, disclosures: Record<string, string>): ComparisonModel {
  const native = isNativePlatform(o.purchase.platform);
  const sellable = native ? o.purchase.store.available : o.purchase.providers.web && o.purchase.options.some((opt) => opt.web);
  const showPrices = !o.overridden && sellable;

  let notice: string | null = null;
  if (o.overridden) {
    notice = "This server gives every household this plan, so there's nothing to buy.";
  } else if (o.purchase.blockedReason) {
    notice = o.purchase.blockedReason;
  } else if (!sellable) {
    notice = native
      ? "Subscriptions in the app aren't available on this server yet. Plenty Free keeps working as usual."
      : "Paid plans aren't available on this server yet. Plenty Free keeps working as usual.";
  }

  const cards = COMPARED_PLANS.map((id): PlanCardModel => {
    const info = PLANS[id];
    const perPeriod = <T>(make: (period: BillingPeriod) => T) =>
      Object.fromEntries(BILLING_PERIODS.map((p) => [p, make(p)])) as Record<BillingPeriod, T>;
    return {
      id,
      name: info.name,
      shortName: NAME_WITHOUT_BRAND(id),
      tagline: info.tagline,
      highlights: info.highlights,
      current: id === o.plan,
      price: perPeriod((period) =>
        id === "free" || showPrices ? { ...money(id, period), saving: period === "annual" ? savingText(id) : null } : null,
      ),
      actions: perPeriod((period) => planAction(o, id, period)),
      disclosure: perPeriod((period) => {
        // The terms sit beside a button that starts a purchase, nowhere else.
        const kind = planAction(o, id, period).kind;
        if (id === "free" || !showPrices || (kind !== "checkout" && kind !== "store")) return null;
        if (native) {
          const provider = o.purchase.store.provider;
          return provider && (id === "plus" || id === "family") ? storeDisclosure(provider, id, period) : null;
        }
        return disclosures[`${id}.${period}`] ?? null;
      }),
    };
  });

  return {
    platform: o.purchase.platform,
    showPrices,
    defaultPeriod: o.period && o.reason !== "no_subscription" ? o.period : "monthly",
    notice,
    cards,
    keepNote:
      "Moving to a smaller plan never deletes or hides anything. Your people, kitchen items and history stay; only adding more than the plan covers waits.",
    proNote: "Plenty Pro isn't available yet.",
  };
}
