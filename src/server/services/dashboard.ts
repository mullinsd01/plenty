import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { addDays, hourInTimeZone, relativeDayLabel, toDateString } from "@/lib/dates";
import { PREDICTION_BASIS_LABELS, type Confidence, type PredictionBasis } from "@/lib/domain";
import { pluralNoun } from "@/lib/format";
import { spendSummary, wasteInsights } from "@/lib/insights";
import type { HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { mealPlanItems, receiptItems, receipts, shoppingListItems, preferences } from "@/server/db/schema";
import { toItemView } from "./inventory";
import { computeLiveState, persistPredictions } from "./learning";
import { getOrCreateActiveList, loadShoppingRhythm } from "./shopping";

export interface RunningLowView {
  productId: string;
  name: string;
  label: string;
  daysRemaining: number;
  confidence: Confidence;
  basis: PredictionBasis;
  basisLabel: string;
  reason: string;
  onList: boolean;
}

export interface UseSoonView {
  itemId: string;
  name: string;
  label: string;
  status: string;
  daysUntilExpiry: number | null;
  /** Batches of the same thing folded into this row. */
  count: number;
}

/** Food so far past its date it's almost certainly gone — offered as one tidy-up. */
export interface PastDateView {
  itemIds: string[];
  /** "Banana ×6 · Apple ×2" */
  summary: string;
}

export interface CheckInView {
  productId: string;
  name: string;
}

export interface DashboardView {
  greeting: string;
  firstName: string;
  todayLabel: string;
  today: string;
  kitchenCount: number;
  checkIns: CheckInView[];
  runningLow: RunningLowView[];
  useSoon: UseSoonView[];
  pastDate: PastDateView | null;
  tonightPlanId: string | null;
  upcomingPlanDates: Array<{ id: string; date: string; label: string; mealId: string }>;
  nextShop: { itemCount: number; checkedCount: number; dateLabel: string | null; basis: string };
  recentReceipt: { id: string; store: string | null; dateLabel: string | null; total: number | null; currency: string | null; itemCount: number } | null;
  receiptsNeedingReview: Array<{ id: string; status: string; store: string | null }>;
  insights: string[];
  hasAnyReceipt: boolean;
}

/** Days past its date before Plenty assumes something is gone and offers to clear it out. */
const PAST_DATE_AFTER_DAYS = 4;

function greetingFor(hour: number): string {
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * Everything the home screen needs, computed in one pass from the live
 * kitchen state. Also refreshes stored predictions.
 */
export async function getDashboard(ctx: HouseholdContext, now = new Date()): Promise<DashboardView> {
  return withUser(ctx.user.id, async (tx) => {
    const tz = ctx.household.timezone;
    const today = toDateString(now, tz);
    const live = await computeLiveState(tx, ctx.household, now);
    await persistPredictions(tx, ctx.household, live);

    const list = await getOrCreateActiveList(tx, ctx.household.id);
    const listRows = await tx
      .select({ productId: shoppingListItems.productId, checkedAt: shoppingListItems.checkedAt, dismissedUntil: shoppingListItems.dismissedUntil })
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.listId, list.id), isNull(shoppingListItems.purchasedAt)));
    const visibleList = listRows.filter((r) => !r.dismissedUntil || r.dismissedUntil <= now);
    const onList = new Set(visibleList.map((r) => r.productId).filter(Boolean) as string[]);

    const checkIns: CheckInView[] = [];
    const runningLow: RunningLowView[] = [];
    for (const p of live.predictions.values()) {
      if (p.paused) continue;
      const snoozed = p.items.some((i) => i.checkInSnoozedUntil && i.checkInSnoozedUntil > now);
      if (p.prediction.needsCheckIn && !snoozed) {
        // Loose things counted one by one read better in the plural: "Did you finish the apples?"
        checkIns.push({ productId: p.productId, name: p.product.unit === "each" ? pluralNoun(p.product.name) : p.product.name });
        continue;
      }
      if (p.prediction.daysRemaining <= 5) {
        runningLow.push({
          productId: p.productId,
          name: p.product.name,
          label: p.prediction.label,
          daysRemaining: p.prediction.daysRemaining,
          confidence: p.prediction.confidence,
          basis: p.prediction.basis,
          basisLabel: PREDICTION_BASIS_LABELS[p.prediction.basis],
          reason: p.prediction.reason,
          onList: onList.has(p.productId),
        });
      }
    }
    runningLow.sort((a, b) => a.daysRemaining - b.daysRemaining);

    // One row per product (the soonest batch), and anything long past its date set aside.
    const useSoonByKey = new Map<string, UseSoonView>();
    const pastDateIds: string[] = [];
    const pastDateCounts = new Map<string, number>();
    for (const item of live.activeItems) {
      const view = toItemView(item, live, ctx.household);
      const s = view.useSoon;
      if (s.status === "expired" && (s.daysUntilExpiry ?? 0) <= -PAST_DATE_AFTER_DAYS) {
        pastDateIds.push(item.id);
        pastDateCounts.set(view.name, (pastDateCounts.get(view.name) ?? 0) + 1);
        continue;
      }
      if (view.estimatedFraction < 0.08) continue;
      if (s.status !== "expired" && s.status !== "today" && s.status !== "soon") continue;
      const key = item.productId ?? view.name.toLowerCase();
      const existing = useSoonByKey.get(key);
      if (!existing) {
        useSoonByKey.set(key, { itemId: item.id, name: view.name, label: s.label, status: s.status, daysUntilExpiry: s.daysUntilExpiry, count: 1 });
      } else {
        existing.count += 1;
        if ((s.daysUntilExpiry ?? 99) < (existing.daysUntilExpiry ?? 99)) {
          Object.assign(existing, { itemId: item.id, label: s.label, status: s.status, daysUntilExpiry: s.daysUntilExpiry });
        }
      }
    }
    const useSoon = [...useSoonByKey.values()].sort((a, b) => (a.daysUntilExpiry ?? 99) - (b.daysUntilExpiry ?? 99));
    const pastDate: PastDateView | null = pastDateIds.length
      ? {
          itemIds: pastDateIds,
          summary: [...pastDateCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
            .join(" · "),
        }
      : null;

    const planRows = await tx
      .select({ id: mealPlanItems.id, date: mealPlanItems.date, mealId: mealPlanItems.mealId, status: mealPlanItems.status })
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), gte(mealPlanItems.date, today), lte(mealPlanItems.date, addDays(today, 6)), eq(mealPlanItems.slot, "dinner")))
      .orderBy(asc(mealPlanItems.date));
    const tonight = planRows.find((r) => r.date === today && r.status === "planned") ?? null;

    const rhythm = await loadShoppingRhythm(tx, ctx.household, now);
    const [recent] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.householdId, ctx.household.id), eq(receipts.status, "confirmed"), isNull(receipts.deletedAt)))
      .orderBy(desc(receipts.purchasedAt))
      .limit(1);
    let recentItemCount = 0;
    if (recent) {
      const [c] = await tx
        .select({ n: count() })
        .from(receiptItems)
        .where(and(eq(receiptItems.receiptId, recent.id), eq(receiptItems.status, "accepted")));
      recentItemCount = Number(c?.n ?? 0);
    }
    const pending = await tx
      .select({ id: receipts.id, status: receipts.status, store: receipts.storeName })
      .from(receipts)
      .where(and(eq(receipts.householdId, ctx.household.id), inArray(receipts.status, ["processing", "needs_review"]), isNull(receipts.deletedAt)))
      .orderBy(desc(receipts.createdAt))
      .limit(3);
    const [anyReceipt] = await tx.select({ id: receipts.id }).from(receipts).where(eq(receipts.householdId, ctx.household.id)).limit(1);

    // A couple of genuinely useful learned facts.
    const insights: string[] = [];
    if (rhythm.label && rhythm.basis === "history") insights.push(rhythm.label);
    const waste = wasteInsights(
      [...live.statsRows.values()]
        .filter((s) => live.index.byId.has(s.productId))
        .map((s) => ({
          productId: s.productId,
          name: live.index.byId.get(s.productId)!.name,
          wasteRatio: s.wasteRatio,
          wasteEvents: s.wasteEvents,
          purchaseCount: s.purchaseCount,
        })),
    );
    if (waste[0]) insights.push(`${waste[0].message} ${waste[0].suggestion}`);
    const learned = [...live.statsRows.values()].filter((s) => s.basis === "history").length;
    if (learned >= 3) insights.push(`Plenty has learned how fast your household gets through ${learned} things.`);
    const [prefs] = await tx.select({ weeklyBudget: preferences.weeklyBudget }).from(preferences).where(eq(preferences.householdId, ctx.household.id)).limit(1);
    const receiptTotals = await tx
      .select({ purchasedAt: receipts.purchasedAt, total: receipts.total })
      .from(receipts)
      .where(and(eq(receipts.householdId, ctx.household.id), eq(receipts.status, "confirmed")))
      .orderBy(desc(receipts.purchasedAt))
      .limit(60);
    const spend = spendSummary({
      receipts: receiptTotals
        .filter((r) => r.purchasedAt && r.total !== null)
        .map((r) => ({ date: toDateString(r.purchasedAt!, tz), total: r.total! })),
      today,
      weeklyBudget: prefs?.weeklyBudget ?? null,
    });
    if (spend.label) insights.push(spend.label);

    return {
      greeting: greetingFor(hourInTimeZone(now, tz)),
      firstName: ctx.user.displayName.split(" ")[0],
      todayLabel: new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(now),
      today,
      kitchenCount: live.activeItems.length,
      checkIns: checkIns.slice(0, 3),
      runningLow: runningLow.slice(0, 6),
      useSoon: useSoon.slice(0, 6),
      pastDate,
      tonightPlanId: tonight?.id ?? null,
      upcomingPlanDates: planRows
        .filter((r) => r.date > today && r.status === "planned")
        .slice(0, 3)
        .map((r) => ({ id: r.id, date: r.date, label: relativeDayLabel(r.date, today), mealId: r.mealId })),
      nextShop: {
        itemCount: visibleList.filter((r) => !r.checkedAt).length,
        checkedCount: visibleList.filter((r) => r.checkedAt).length,
        dateLabel: rhythm.nextShopDate ? relativeDayLabel(rhythm.nextShopDate, today) : null,
        basis: rhythm.basis,
      },
      recentReceipt: recent
        ? {
            id: recent.id,
            store: recent.storeName,
            dateLabel: recent.purchasedAt ? relativeDayLabel(toDateString(recent.purchasedAt, tz), today) : null,
            total: recent.total,
            currency: recent.currency,
            itemCount: recentItemCount,
          }
        : null,
      receiptsNeedingReview: pending.map((p) => ({ id: p.id, status: p.status, store: p.store })),
      insights: insights.slice(0, 3),
      hasAnyReceipt: Boolean(anyReceipt),
    };
  });
}
