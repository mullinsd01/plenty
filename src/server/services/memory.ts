import "server-only";
import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { toDateString, WEEKDAY_NAMES } from "@/lib/dates";
import {
  ALLERGEN_LABELS,
  CUISINE_LABELS,
  DIET_LABELS,
  PREDICTION_BASIS_LABELS,
  type Allergen,
  type Confidence,
  type Cuisine,
  type Diet,
  type PredictionBasis,
} from "@/lib/domain";
import { spendSummary, typicalShop, wasteInsights, type SpendSummary, type WasteInsight } from "@/lib/insights";
import { learnAversions } from "@/lib/meals/aversions";
import { formatDuration } from "@/lib/prediction/labels";
import { formatBase, type BaseUnit } from "@/lib/units";
import type { HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { consumptionEvents, consumptionStats, mealPreferences, preferences, receiptItems, receipts } from "@/server/db/schema";
import { notFound } from "@/server/errors";
import { computeLiveState, refreshLearning } from "./learning";
import { loadPlannableMeals } from "./meal-data";
import { loadShoppingRhythm, syncShoppingList } from "./shopping";

export interface LearnedProductView {
  productId: string;
  name: string;
  basis: PredictionBasis;
  basisLabel: string;
  confidence: Confidence;
  observations: number;
  /** "2 L lasts about 4 days" / "About 1.5 L a week". */
  paceLabel: string | null;
  purchaseLabel: string | null;
  isStaple: boolean;
  stapleOverride: boolean | null;
  paused: boolean;
  wasteRatio: number;
}

export interface HouseholdMemoryView {
  summary: { learnedProducts: number; estimatedProducts: number; observations: number; receipts: number };
  products: LearnedProductView[];
  staples: LearnedProductView[];
  waste: WasteInsight[];
  rhythm: { label: string | null; weekday: string | null; intervalDays: number; basis: string; nextShop: string };
  spend: SpendSummary;
  typicalShop: { medianItems: number | null; medianSpend: number | null };
  currency: string;
  meals: {
    favourites: Array<{ id: string; name: string; timesCooked: number }>;
    disliked: Array<{ id: string; name: string }>;
    notes: string[];
  };
  preferences: {
    diets: string[];
    allergies: string[];
    dislikes: string[];
    cuisines: string[];
    weeklyBudget: number | null;
  };
}

function paceLabel(rate: number | null, base: BaseUnit, typical: number | null): string | null {
  if (!rate || rate <= 0) return null;
  if (typical && typical > 0) {
    const days = typical / rate;
    return `${formatBase(typical, base)} lasts about ${formatDuration(days)}`;
  }
  return `About ${formatBase(rate * 7, base)} a week`;
}

/** Everything Plenty has learned about the household — shown so it's never a black box. */
export async function getHouseholdMemory(ctx: HouseholdContext, now = new Date()): Promise<HouseholdMemoryView> {
  return withUser(ctx.user.id, async (tx) => {
    const tz = ctx.household.timezone;
    const today = toDateString(now, tz);
    const live = await computeLiveState(tx, ctx.household, now);
    const stats = await tx.select().from(consumptionStats).where(eq(consumptionStats.householdId, ctx.household.id));

    const products: LearnedProductView[] = stats
      .filter((s) => live.index.byId.has(s.productId) && (s.purchaseCount > 0 || s.observations > 0 || s.stapleOverride !== null))
      .map((s) => {
        const product = live.index.byId.get(s.productId)!;
        return {
          productId: s.productId,
          name: product.name,
          basis: s.basis as PredictionBasis,
          basisLabel: PREDICTION_BASIS_LABELS[s.basis as PredictionBasis],
          confidence: s.confidence as Confidence,
          observations: s.observations,
          paceLabel: paceLabel(s.dailyRate, s.baseUnit as BaseUnit, s.typicalPurchaseAmount),
          purchaseLabel:
            // One gap between two purchases isn't a pattern yet.
            s.typicalPurchaseIntervalDays && s.purchaseCount >= 3
              ? `Bought about every ${formatDuration(s.typicalPurchaseIntervalDays)}`
              : s.purchaseCount === 1
                ? "Bought once so far"
                : s.purchaseCount === 2
                  ? "Bought twice so far"
                  : null,
          isStaple: s.stapleOverride ?? s.isStaple,
          stapleOverride: s.stapleOverride,
          paused: s.predictionsPaused,
          wasteRatio: s.wasteRatio,
        };
      })
      .sort((a, b) => b.observations - a.observations || a.name.localeCompare(b.name));

    const waste = wasteInsights(
      stats
        .filter((s) => live.index.byId.has(s.productId))
        .map((s) => ({
          productId: s.productId,
          name: live.index.byId.get(s.productId)!.name,
          wasteRatio: s.wasteRatio,
          wasteEvents: s.wasteEvents,
          purchaseCount: s.purchaseCount,
        })),
    );

    const rhythm = await loadShoppingRhythm(tx, ctx.household, now);
    const receiptRows = await tx
      .select({ id: receipts.id, purchasedAt: receipts.purchasedAt, total: receipts.total })
      .from(receipts)
      .where(and(eq(receipts.householdId, ctx.household.id), eq(receipts.status, "confirmed"), isNotNull(receipts.purchasedAt)))
      .orderBy(desc(receipts.purchasedAt))
      .limit(80);
    const counts = receiptRows.length
      ? await tx
          .select({ receiptId: receiptItems.receiptId, n: count() })
          .from(receiptItems)
          .where(and(inArray(receiptItems.receiptId, receiptRows.map((r) => r.id)), eq(receiptItems.status, "accepted")))
          .groupBy(receiptItems.receiptId)
      : [];
    const countBy = new Map(counts.map((c) => [c.receiptId, Number(c.n)]));
    const [prefs] = await tx.select().from(preferences).where(eq(preferences.householdId, ctx.household.id)).limit(1);
    const spend = spendSummary({
      receipts: receiptRows.filter((r) => r.total !== null).map((r) => ({ date: toDateString(r.purchasedAt!, tz), total: r.total! })),
      today,
      weeklyBudget: prefs?.weeklyBudget ?? null,
    });

    const prefRows = await tx.select().from(mealPreferences).where(eq(mealPreferences.householdId, ctx.household.id));
    const mealMap = await loadPlannableMeals(tx, ctx.household.id, prefRows.map((p) => p.mealId));
    const aversions = learnAversions(
      [...mealMap.values()],
      prefRows.map((p) => ({
        mealId: p.mealId,
        rating: p.rating as -1 | 0 | 1,
        saved: p.saved,
        timesPlanned: p.timesPlanned,
        timesCooked: p.timesCooked,
        timesRejected: p.timesRejected,
        lastPlannedAt: p.lastPlannedAt,
        lastCookedAt: p.lastCookedAt,
        lastRejectedAt: p.lastRejectedAt,
      })),
    );
    const favourites = prefRows
      .filter((p) => (p.rating === 1 || p.saved || p.timesCooked >= 2) && mealMap.has(p.mealId))
      .sort((a, b) => b.timesCooked - a.timesCooked)
      .slice(0, 12)
      .map((p) => ({ id: p.mealId, name: mealMap.get(p.mealId)!.name, timesCooked: p.timesCooked }));
    const disliked = prefRows
      .filter((p) => p.rating === -1 && mealMap.has(p.mealId))
      .map((p) => ({ id: p.mealId, name: mealMap.get(p.mealId)!.name }));
    const [obs] = await tx.select({ n: count() }).from(consumptionEvents).where(eq(consumptionEvents.householdId, ctx.household.id));
    const [scanned] = await tx
      .select({ n: count() })
      .from(receipts)
      .where(and(eq(receipts.householdId, ctx.household.id), eq(receipts.status, "confirmed")));

    return {
      summary: {
        learnedProducts: products.filter((p) => p.basis === "history").length,
        estimatedProducts: products.filter((p) => p.basis === "estimate").length,
        observations: Number(obs?.n ?? 0),
        receipts: Number(scanned?.n ?? 0),
      },
      products,
      staples: products.filter((p) => p.isStaple),
      waste,
      rhythm: {
        label: rhythm.label,
        weekday: rhythm.typicalWeekday !== null ? WEEKDAY_NAMES[rhythm.typicalWeekday] : null,
        intervalDays: rhythm.intervalDays,
        basis: rhythm.basis,
        nextShop: rhythm.nextShopDate,
      },
      spend,
      typicalShop: typicalShop(receiptRows.map((r) => ({ itemCount: countBy.get(r.id) ?? 0, total: r.total }))),
      currency: ctx.household.currency,
      meals: { favourites, disliked, notes: aversions.notes },
      preferences: {
        diets: ((prefs?.diets ?? []) as Diet[]).map((d) => DIET_LABELS[d] ?? d),
        allergies: ((prefs?.allergies ?? []) as Allergen[]).map((a) => ALLERGEN_LABELS[a] ?? a),
        dislikes: prefs?.dislikedIngredients ?? [],
        cuisines: ((prefs?.favouriteCuisines ?? []) as Cuisine[]).map((c) => CUISINE_LABELS[c] ?? c),
        weeklyBudget: prefs?.weeklyBudget ?? null,
      },
    };
  });
}

/** Stop (or resume) run-out predictions for one product. */
export async function setPredictionsPaused(ctx: HouseholdContext, productId: string, paused: boolean): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const updated = await tx
      .update(consumptionStats)
      .set({ predictionsPaused: paused })
      .where(and(eq(consumptionStats.householdId, ctx.household.id), eq(consumptionStats.productId, productId)))
      .returning({ id: consumptionStats.id });
    if (updated.length === 0) throw notFound("That product");
    await refreshLearning(tx, ctx.household, [], now);
    await syncShoppingList(tx, ctx.household, now);
  });
}

/** Forget everything learned about how fast the household uses a product. */
export async function resetProductLearning(ctx: HouseholdContext, productId: string): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .delete(consumptionEvents)
      .where(and(eq(consumptionEvents.householdId, ctx.household.id), eq(consumptionEvents.productId, productId)));
    await refreshLearning(tx, ctx.household, [productId], now);
    await syncShoppingList(tx, ctx.household, now);
  });
}

