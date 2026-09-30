import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import type { ProductInfo } from "@/lib/catalog/types";
import { computeConsumptionStats } from "@/lib/consumption/stats";
import type { BatchState, ConsumptionObservation, ConsumptionStats, RunOutPrediction } from "@/lib/consumption/types";
import { toDateString, DAY_MS } from "@/lib/dates";
import { adultEquivalents, type Confidence, type ConsumptionOutcome, type PredictionBasis } from "@/lib/domain";
import { estimateBatchFractions, predictRunOut, type PredictionStats } from "@/lib/prediction/engine";
import { baseUnitFor, toBase, toBaseUnit, unitDimension, type BaseUnit, type Unit } from "@/lib/units";
import type { HouseholdInfo } from "@/server/auth/context";
import type { Queryable } from "@/server/db/client";
import {
  consumptionEvents,
  consumptionStats,
  inventoryItems,
  predictions,
  type DbConsumptionStats,
  type DbInventoryItem,
} from "@/server/db/schema";
import { loadProductIndex, type ProductIndex } from "./products";

/** The base unit a product's quantities are learned in. */
export function productBase(product: ProductInfo): BaseUnit {
  return baseUnitFor(unitDimension(product.unit));
}

/** An item's purchased amount in its product's base unit (null if the units can't be reconciled). */
export function itemBaseAmount(
  item: { quantity: number; unit: string },
  product: ProductInfo | null,
): { amount: number; unit: BaseUnit } | null {
  const unit = item.unit as Unit;
  if (!product) {
    const b = toBase(item.quantity, unit);
    return { amount: b.amount, unit: b.unit };
  }
  const target = productBase(product);
  const amount = toBaseUnit(item.quantity, unit, target, product);
  return amount === null ? null : { amount, unit: target };
}

export function householdSizeOf(household: Pick<HouseholdInfo, "adults" | "children">): number {
  return adultEquivalents(household.adults, household.children);
}

// ─── Recording consumption ──────────────────────────────────────────────────

/**
 * Record one completed lifecycle of an item (it was finished, wasted or
 * expired). This is the raw observation Plenty learns consumption rates from.
 *
 * Consumption of a batch is assumed to start when it was opened, or — if the
 * household was still using an earlier batch of the same product — when that
 * earlier batch ran out (households use the old milk before the new one).
 */
export async function recordLifecycleEnd(
  db: Queryable,
  args: {
    household: Pick<HouseholdInfo, "id" | "adults" | "children">;
    item: DbInventoryItem;
    product: ProductInfo | null;
    outcome: ConsumptionOutcome;
    endedAt: Date;
    /** Fraction of the whole purchase that was thrown away (0 when finished normally). */
    wastedFraction: number;
  },
): Promise<void> {
  const { item, product, household } = args;
  const base = itemBaseAmount(item, product);
  if (!base || base.amount <= 0) return;

  let startedAt = item.openedAt ?? item.purchasedAt;
  if (item.productId) {
    const [previous] = await db
      .select({ endedAt: consumptionEvents.endedAt })
      .from(consumptionEvents)
      .where(
        and(
          eq(consumptionEvents.householdId, household.id),
          eq(consumptionEvents.productId, item.productId),
          gt(consumptionEvents.endedAt, startedAt),
          lt(consumptionEvents.endedAt, args.endedAt),
          ne(consumptionEvents.inventoryItemId, item.id),
        ),
      )
      .orderBy(desc(consumptionEvents.endedAt))
      .limit(1);
    if (previous) startedAt = previous.endedAt;
  }

  const durationDays = Math.max(0.5, (args.endedAt.getTime() - startedAt.getTime()) / DAY_MS);
  const wasted = Math.min(1, Math.max(0, args.wastedFraction));
  await db.insert(consumptionEvents).values({
    householdId: household.id,
    productId: item.productId,
    inventoryItemId: item.id,
    outcome: args.outcome,
    amountUsedBase: base.amount * (1 - wasted),
    amountWastedBase: base.amount * wasted,
    baseUnit: base.unit,
    startedAt,
    endedAt: args.endedAt,
    durationDays,
    householdSize: householdSizeOf(household),
  });
}

// ─── Statistics ─────────────────────────────────────────────────────────────

function priorPerPerson(product: ProductInfo): number | null {
  if (!product.dailyUsePerPerson || product.dailyUsePerPerson <= 0) return null;
  return toBaseUnit(product.dailyUsePerPerson, product.unit, productBase(product), product);
}

/** Pure: stats for a product with no learning history yet (Plenty's starting estimate). */
export function priorOnlyStats(product: ProductInfo, householdSize: number, now: Date): ConsumptionStats {
  return computeConsumptionStats({
    baseUnit: productBase(product),
    observations: [],
    purchases: [],
    priorDailyPerPerson: priorPerPerson(product),
    householdSize,
    now,
  });
}

/** Recompute and store learned statistics for the given products. */
export async function refreshProductStats(
  db: Queryable,
  household: Pick<HouseholdInfo, "id" | "adults" | "children">,
  productIds: string[],
  index: ProductIndex,
  now: Date,
): Promise<Map<string, ConsumptionStats>> {
  const out = new Map<string, ConsumptionStats>();
  const ids = Array.from(new Set(productIds)).filter((id) => index.byId.has(id));
  if (ids.length === 0) return out;
  const size = householdSizeOf(household);

  const events = await db
    .select()
    .from(consumptionEvents)
    .where(and(eq(consumptionEvents.householdId, household.id), inArray(consumptionEvents.productId, ids)));
  const purchases = await db
    .select({
      productId: inventoryItems.productId,
      purchasedAt: inventoryItems.purchasedAt,
      quantity: inventoryItems.quantity,
      unit: inventoryItems.unit,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.householdId, household.id),
        inArray(inventoryItems.productId, ids),
        ne(inventoryItems.status, "removed"),
        isNull(inventoryItems.deletedAt),
      ),
    );

  for (const productId of ids) {
    const product = index.byId.get(productId)!;
    const base = productBase(product);
    const observations: ConsumptionObservation[] = events
      .filter((e) => e.productId === productId && e.baseUnit === base)
      .map((e) => ({
        amountUsedBase: e.amountUsedBase,
        amountWastedBase: e.amountWastedBase,
        durationDays: e.durationDays,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        outcome: e.outcome,
        householdSize: e.householdSize,
      }));
    const purchaseObs = purchases
      .filter((p) => p.productId === productId)
      .map((p) => ({ purchasedAt: p.purchasedAt, amount: itemBaseAmount(p, product) }))
      .filter((p): p is { purchasedAt: Date; amount: { amount: number; unit: BaseUnit } } => p.amount !== null)
      .map((p) => ({ purchasedAt: p.purchasedAt, amountBase: p.amount.amount }));

    const stats = computeConsumptionStats({
      baseUnit: base,
      observations,
      purchases: purchaseObs,
      priorDailyPerPerson: priorPerPerson(product),
      householdSize: size,
      now,
    });
    out.set(productId, stats);

    const values = {
      baseUnit: stats.baseUnit,
      observations: stats.observations,
      outliersExcluded: stats.outliersExcluded,
      dailyRate: stats.dailyRate,
      historyMedianRate: stats.historyMedianRate,
      historyMeanRate: stats.historyMeanRate,
      recentRate: stats.recentRate,
      priorRate: stats.priorRate,
      variability: stats.variability,
      seasonalFactor: stats.seasonalFactor,
      typicalPurchaseAmount: stats.typicalPurchaseAmount,
      typicalPurchaseIntervalDays: stats.typicalPurchaseIntervalDays,
      purchaseCount: stats.purchaseCount,
      wasteRatio: stats.wasteRatio,
      wasteEvents: stats.wasteEvents,
      lastPurchasedAt: stats.lastPurchasedAt,
      lastFinishedAt: stats.lastFinishedAt,
      basis: stats.basis,
      confidence: stats.confidence,
      isStaple: stats.isStaple,
    };
    await db
      .insert(consumptionStats)
      .values({ householdId: household.id, productId, ...values })
      .onConflictDoUpdate({ target: [consumptionStats.householdId, consumptionStats.productId], set: values });
  }
  return out;
}

function statsRowToPredictionStats(row: DbConsumptionStats): PredictionStats {
  return {
    dailyRate: row.dailyRate,
    basis: row.basis as PredictionBasis,
    confidence: row.confidence as Confidence,
    variability: row.variability,
    observations: row.observations,
    baseUnit: row.baseUnit as BaseUnit,
    typicalPurchaseAmount: row.typicalPurchaseAmount,
  };
}

// ─── Live predictions ───────────────────────────────────────────────────────

export interface ProductPrediction {
  productId: string;
  product: ProductInfo;
  prediction: RunOutPrediction;
  items: DbInventoryItem[];
  stats: PredictionStats;
  paused: boolean;
}

export interface LiveState {
  now: Date;
  index: ProductIndex;
  activeItems: DbInventoryItem[];
  /** Estimated fraction remaining right now for every active item. */
  itemFractions: Map<string, number>;
  /** Per-product run-out predictions (only products Plenty can reasonably predict). */
  predictions: Map<string, ProductPrediction>;
  /** Base units consumed per day for each item's product, for use-soon projections. */
  dailyRates: Map<string, number>;
  statsRows: Map<string, DbConsumptionStats>;
}

function batchOf(item: DbInventoryItem, product: ProductInfo | null): BatchState | null {
  const base = itemBaseAmount(item, product);
  if (!base) return null;
  const expiry = item.actualExpiry ?? item.estimatedExpiry;
  return {
    itemId: item.id,
    quantityBase: base.amount,
    knownFraction: item.remainingFraction,
    levelUpdatedAt: item.levelUpdatedAt,
    purchasedAt: item.purchasedAt,
    expiresAt: expiry ? new Date(`${expiry}T23:59:59Z`) : null,
  };
}

/**
 * Compute the household's current estimated state in memory: remaining
 * levels for each item and run-out predictions per product. Deterministic.
 */
export async function computeLiveState(
  db: Queryable,
  household: Pick<HouseholdInfo, "id" | "adults" | "children" | "timezone">,
  now: Date,
): Promise<LiveState> {
  const index = await loadProductIndex(db, household.id);
  const activeItems = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.householdId, household.id), eq(inventoryItems.status, "active"), isNull(inventoryItems.deletedAt)))
    .orderBy(asc(inventoryItems.purchasedAt));
  const statsRowsList = await db.select().from(consumptionStats).where(eq(consumptionStats.householdId, household.id));
  const statsRows = new Map(statsRowsList.map((r) => [r.productId, r]));
  const size = householdSizeOf(household);

  const itemFractions = new Map<string, number>();
  const predictionsOut = new Map<string, ProductPrediction>();
  const dailyRates = new Map<string, number>();

  const byProduct = new Map<string, DbInventoryItem[]>();
  for (const item of activeItems) {
    if (item.productId && index.byId.has(item.productId)) {
      const list = byProduct.get(item.productId) ?? [];
      list.push(item);
      byProduct.set(item.productId, list);
    } else {
      itemFractions.set(item.id, item.remainingFraction);
    }
  }

  for (const [productId, items] of byProduct) {
    const product = index.byId.get(productId)!;
    const row = statsRows.get(productId);
    const stats = row && row.baseUnit === productBase(product) ? statsRowToPredictionStats(row) : priorOnlyStats(product, size, now);
    const batches = items.map((i) => batchOf(i, product)).filter((b): b is BatchState => b !== null);
    const rate = stats.dailyRate && stats.dailyRate > 0 ? stats.dailyRate : null;
    const fractions = estimateBatchFractions(batches, rate, now);
    for (const item of items) itemFractions.set(item.id, fractions[item.id] ?? item.remainingFraction);
    if (rate) dailyRates.set(productId, rate);

    const paused = row?.predictionsPaused ?? false;
    if (!rate || batches.length === 0) continue;
    const prediction = predictRunOut({ batches, stats, productName: product.name, householdSize: size, now });
    if (prediction) predictionsOut.set(productId, { productId, product, prediction, items, stats, paused });
  }

  return { now, index, activeItems, itemFractions, predictions: predictionsOut, dailyRates, statsRows };
}

/**
 * Persist current predictions (used by notifications, search and history).
 * Products without active stock lose their prediction.
 */
export async function persistPredictions(
  db: Queryable,
  household: Pick<HouseholdInfo, "id" | "timezone">,
  live: LiveState,
): Promise<void> {
  const keep: string[] = [];
  for (const p of live.predictions.values()) {
    if (p.paused) continue;
    keep.push(p.productId);
    const snoozed = p.items.some((i) => i.checkInSnoozedUntil && i.checkInSnoozedUntil > live.now);
    const values = {
      name: p.product.name,
      remainingBase: p.prediction.remainingBase,
      baseUnit: p.stats.baseUnit,
      dailyRate: p.prediction.dailyRate,
      daysRemaining: p.prediction.daysRemaining,
      daysLow: p.prediction.daysLow,
      daysHigh: p.prediction.daysHigh,
      runOutOn: toDateString(p.prediction.runOutAt, household.timezone),
      confidence: p.prediction.confidence,
      basis: p.prediction.basis,
      reason: p.prediction.reason,
      needsCheckIn: p.prediction.needsCheckIn && !snoozed,
      computedAt: live.now,
    };
    await db
      .insert(predictions)
      .values({ householdId: household.id, productId: p.productId, ...values })
      .onConflictDoUpdate({
        target: [predictions.householdId, predictions.productId],
        targetWhere: sql`${predictions.productId} is not null`,
        set: values,
      });
  }
  await db
    .delete(predictions)
    .where(
      keep.length
        ? and(eq(predictions.householdId, household.id), notInArray(predictions.productId, keep))
        : eq(predictions.householdId, household.id),
    );
}

/** Recompute learning for touched products, then refresh stored predictions. */
export async function refreshLearning(
  db: Queryable,
  household: Pick<HouseholdInfo, "id" | "adults" | "children" | "timezone">,
  productIds: Array<string | null>,
  now: Date,
): Promise<void> {
  const ids = productIds.filter((id): id is string => Boolean(id));
  if (ids.length > 0) {
    const index = await loadProductIndex(db, household.id);
    await refreshProductStats(db, household, ids, index, now);
  }
  const live = await computeLiveState(db, household, now);
  await persistPredictions(db, household, live);
}
