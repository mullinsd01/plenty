import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import type { ProductInfo } from "@/lib/catalog/types";
import { computeConsumptionStats } from "@/lib/consumption/stats";
import type { BatchState, ConsumptionObservation, ConsumptionStats, RunOutPrediction } from "@/lib/consumption/types";
import { addDays, toDateString, DAY_MS, zonedDateTimeToInstant } from "@/lib/dates";
import { adultEquivalents, type Confidence, type ConsumptionOutcome, type PredictionBasis } from "@/lib/domain";
import type { PlanFlags } from "@/lib/billing/plans";
import { estimateBatchFractions, predictRunOut, simulateBatches, type PredictionStats } from "@/lib/prediction/engine";
import { baseUnitFor, toBase, toBaseUnit, unitDimension, type BaseUnit, type Unit } from "@/lib/units";
import { feedsHouseholdPattern, HOUSEHOLD_SCOPE, learningKey, learningScopeOf, scopeOf, scopeOwner } from "@/lib/members/scope";
import type { HouseholdInfo } from "@/server/auth/context";
import type { Queryable } from "@/server/db/client";
import {
  consumptionEvents,
  consumptionStats,
  inventoryEvents,
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

/** What the learning code needs to know about a household. */
export type LearningHousehold = Pick<HouseholdInfo, "id" | "adults" | "children" | "timezone" | keyof PlanFlags>;

/** A person's own pattern is about one person; the household's is about everyone. */
function sizeForScope(scope: string, household: Pick<HouseholdInfo, "adults" | "children">): number {
  return scope === HOUSEHOLD_SCOPE ? householdSizeOf(household) : 1;
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

  // Something added part-used only had that much left to use.
  const [added] = await db
    .select({ fraction: inventoryEvents.fractionAfter })
    .from(inventoryEvents)
    .where(and(eq(inventoryEvents.inventoryItemId, item.id), eq(inventoryEvents.type, "added")))
    .limit(1);
  const startFraction = Math.min(1, Math.max(0, added?.fraction ?? 1));
  const amount = base.amount * startFraction;
  if (amount <= 0) return;

  // The window starts at purchase (or when it was opened, if someone told us) — the
  // amount above is what was there at that point, so the two stay consistent.
  let startedAt = item.openedAt ?? item.purchasedAt;
  // Whose pattern this is: recorded as the item's own scope, whatever the plan, so an upgrade
  // can give people their own patterns from history that already exists.
  const scope = scopeOf(item);
  if (item.productId) {
    const [previous] = await db
      .select({ endedAt: consumptionEvents.endedAt })
      .from(consumptionEvents)
      .where(
        and(
          eq(consumptionEvents.householdId, household.id),
          eq(consumptionEvents.productId, item.productId),
          eq(consumptionEvents.scope, scope),
          gt(consumptionEvents.endedAt, startedAt),
          lt(consumptionEvents.endedAt, args.endedAt),
          ne(consumptionEvents.inventoryItemId, item.id),
        ),
      )
      .orderBy(desc(consumptionEvents.endedAt))
      .limit(1);
    if (previous) startedAt = previous.endedAt;
  }

  const elapsedDays = (args.endedAt.getTime() - startedAt.getTime()) / DAY_MS;
  // An end before the start is a bad inference, not a real observation — don't learn from it.
  if (!(elapsedDays > 0)) return;
  const durationDays = Math.max(0.5, elapsedDays);
  const wasted = Math.min(1, Math.max(0, args.wastedFraction));
  await db.insert(consumptionEvents).values({
    householdId: household.id,
    productId: item.productId,
    inventoryItemId: item.id,
    scope,
    ownerMemberId: item.ownerMemberId,
    outcome: args.outcome,
    amountUsedBase: amount * (1 - wasted),
    amountWastedBase: amount * wasted,
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

/**
 * Recompute and store learned statistics for the given products, once for the
 * household and once for each person whose items (or history) they appear in.
 * Returned in a map keyed by `learningKey(productId, scope)`.
 */
export async function refreshProductStats(
  db: Queryable,
  household: LearningHousehold,
  productIds: string[],
  index: ProductIndex,
  now: Date,
): Promise<Map<string, ConsumptionStats>> {
  const out = new Map<string, ConsumptionStats>();
  const ids = Array.from(new Set(productIds)).filter((id) => index.byId.has(id));
  if (ids.length === 0) return out;
  const individual = household.individualPatterns;

  const events = await db
    .select()
    .from(consumptionEvents)
    .where(and(eq(consumptionEvents.householdId, household.id), inArray(consumptionEvents.productId, ids)));
  const purchases = await db
    .select({
      productId: inventoryItems.productId,
      ownerMemberId: inventoryItems.ownerMemberId,
      visibility: inventoryItems.visibility,
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
    const productEvents = events.filter((e) => e.productId === productId && e.baseUnit === base);
    const productPurchases = purchases.filter((p) => p.productId === productId);

    // The household's own pattern always exists; each person with their own history or items gets one too.
    const scopes = new Set<string>([HOUSEHOLD_SCOPE]);
    if (individual) {
      for (const e of productEvents) if (e.scope !== HOUSEHOLD_SCOPE) scopes.add(e.scope);
      for (const p of productPurchases) scopes.add(learningScopeOf(p, true));
    } else {
      for (const e of productEvents) if (e.scope.startsWith("private:")) scopes.add(e.scope);
      for (const p of productPurchases) if (p.visibility === "private") scopes.add(learningScopeOf(p, false));
    }

    for (const scope of scopes) {
      const own = scope === HOUSEHOLD_SCOPE;
      const observations: ConsumptionObservation[] = productEvents
        .filter((e) => (own ? feedsHouseholdPattern(e.scope, individual) : e.scope === scope))
        .map((e) => ({
          amountUsedBase: e.amountUsedBase,
          amountWastedBase: e.amountWastedBase,
          durationDays: e.durationDays,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          outcome: e.outcome,
          // A person's own pattern is already about one person, so there's nothing to rescale.
          householdSize: own || !individual ? e.householdSize : 1,
        }));
      const purchaseObs = productPurchases
        .filter((p) => (own ? feedsHouseholdPattern(scopeOf(p), individual) : scopeOf(p) === scope))
        .map((p) => ({ purchasedAt: p.purchasedAt, amount: itemBaseAmount(p, product) }))
        .filter((p): p is { purchasedAt: Date; amount: { amount: number; unit: BaseUnit } } => p.amount !== null)
        .map((p) => ({ purchasedAt: p.purchasedAt, amountBase: p.amount.amount }));

      const stats = computeConsumptionStats({
        baseUnit: base,
        observations,
        purchases: purchaseObs,
        priorDailyPerPerson: priorPerPerson(product),
        householdSize: own ? householdSizeOf(household) : 1,
        now,
      });
      out.set(learningKey(productId, scope), stats);

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
        .values({ householdId: household.id, productId, scope, ownerMemberId: scopeOwner(scope), ...values })
        .onConflictDoUpdate({ target: [consumptionStats.householdId, consumptionStats.productId, consumptionStats.scope], set: values });
    }
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
  /** Whose pace this is: the household, or one member (see `src/lib/members/scope.ts`). */
  scope: string;
  ownerMemberId: string | null;
  prediction: RunOutPrediction;
  /**
   * When the stock most likely ran out (or will): in the past when Plenty
   * thinks it's already gone. Used to date a confirmed finish realistically.
   */
  emptyAt: Date;
  items: DbInventoryItem[];
  stats: PredictionStats;
  paused: boolean;
}

export interface LiveState {
  now: Date;
  index: ProductIndex;
  /** Whether each person's items are learned separately (the plan includes individual patterns). */
  individual: boolean;
  activeItems: DbInventoryItem[];
  /** Estimated fraction remaining right now for every active item. */
  itemFractions: Map<string, number>;
  /** Run-out predictions per product and scope (only what Plenty can reasonably predict), keyed by `learningKey`. */
  predictions: Map<string, ProductPrediction>;
  /** Base units consumed per day for each product and scope, keyed by `learningKey`, for use-soon projections. */
  dailyRates: Map<string, number>;
  statsRows: Map<string, DbConsumptionStats>;
}

/** The scope an item is learned under right now. */
export function itemScope(live: Pick<LiveState, "individual">, item: Pick<DbInventoryItem, "ownerMemberId" | "visibility">): string {
  return learningScopeOf(item, live.individual);
}

/** The run-out prediction that covers an item, if there is one. */
export function predictionFor(live: LiveState, item: DbInventoryItem): ProductPrediction | undefined {
  return item.productId ? live.predictions.get(learningKey(item.productId, itemScope(live, item))) : undefined;
}

/** The household's (or person's) daily use of an item's product, in base units. */
export function dailyRateFor(live: LiveState, item: DbInventoryItem): number | undefined {
  return item.productId ? live.dailyRates.get(learningKey(item.productId, itemScope(live, item))) : undefined;
}

function batchOf(item: DbInventoryItem, product: ProductInfo | null, timeZone: string): BatchState | null {
  const base = itemBaseAmount(item, product);
  if (!base) return null;
  const expiry = item.actualExpiry ?? item.estimatedExpiry;
  return {
    itemId: item.id,
    quantityBase: base.amount,
    knownFraction: item.remainingFraction,
    levelUpdatedAt: item.levelUpdatedAt,
    purchasedAt: item.purchasedAt,
    // Good until the end of that day where the household lives.
    expiresAt: expiry ? new Date(zonedDateTimeToInstant(addDays(expiry, 1), 0, timeZone).getTime() - 1) : null,
  };
}

/**
 * Compute the household's current estimated state in memory: remaining
 * levels for each item and run-out predictions per product and scope.
 * Deterministic. Works only with what the caller can see, so a member's
 * private items never influence anyone else's view.
 */
export async function computeLiveState(db: Queryable, household: LearningHousehold, now: Date): Promise<LiveState> {
  const index = await loadProductIndex(db, household.id);
  const individual = household.individualPatterns;
  const activeItems = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.householdId, household.id), eq(inventoryItems.status, "active"), isNull(inventoryItems.deletedAt)))
    .orderBy(asc(inventoryItems.purchasedAt));
  const statsRowsList = await db.select().from(consumptionStats).where(eq(consumptionStats.householdId, household.id));
  const statsRows = new Map(statsRowsList.map((r) => [learningKey(r.productId, r.scope), r]));

  const itemFractions = new Map<string, number>();
  const predictionsOut = new Map<string, ProductPrediction>();
  const dailyRates = new Map<string, number>();

  const groups = new Map<string, { productId: string; scope: string; items: DbInventoryItem[] }>();
  for (const item of activeItems) {
    if (item.productId && index.byId.has(item.productId)) {
      const scope = learningScopeOf(item, individual);
      const key = learningKey(item.productId, scope);
      const group = groups.get(key);
      if (group) group.items.push(item);
      else groups.set(key, { productId: item.productId, scope, items: [item] });
    } else {
      itemFractions.set(item.id, item.remainingFraction);
    }
  }

  for (const [key, { productId, scope, items }] of groups) {
    const product = index.byId.get(productId)!;
    const row = statsRows.get(key);
    const size = sizeForScope(scope, household);
    const stats = row && row.baseUnit === productBase(product) ? statsRowToPredictionStats(row) : priorOnlyStats(product, size, now);
    const batches = items.map((i) => batchOf(i, product, household.timezone)).filter((b): b is BatchState => b !== null);
    // Without predictions in the plan, levels are only what people have said: nothing is estimated downwards.
    const rate = household.predictive && stats.dailyRate && stats.dailyRate > 0 ? stats.dailyRate : null;
    const fractions = estimateBatchFractions(batches, rate, now);
    for (const item of items) itemFractions.set(item.id, fractions[item.id] ?? item.remainingFraction);
    if (rate) dailyRates.set(key, rate);

    const paused = row?.predictionsPaused ?? false;
    if (!rate || batches.length === 0) continue;
    const prediction = predictRunOut({ batches, stats, productName: product.name, householdSize: size, now });
    if (prediction) {
      // A run-out that has already happened is dated from the last thing we knew for sure.
      const sim = simulateBatches(batches, rate, now);
      const emptyAt =
        prediction.remainingBase <= 0 && sim.lastSnapshotAt
          ? new Date(Math.min(now.getTime(), sim.lastSnapshotAt.getTime() + (sim.remainingAtLastSnapshot / rate) * DAY_MS))
          : prediction.runOutAt;
      predictionsOut.set(key, {
        productId,
        product,
        scope,
        ownerMemberId: scopeOwner(scope),
        prediction,
        emptyAt,
        items,
        stats,
        paused,
      });
    }
  }

  return { now, index, individual, activeItems, itemFractions, predictions: predictionsOut, dailyRates, statsRows };
}

/**
 * Persist current predictions (used by notifications, search and history).
 * Products without active stock lose their prediction. Only the caller's own
 * view is touched: other people's private predictions aren't visible to
 * them, so they're neither read nor removed.
 */
export async function persistPredictions(
  db: Queryable,
  household: Pick<HouseholdInfo, "id" | "timezone">,
  live: LiveState,
): Promise<void> {
  const keep = new Set<string>();
  for (const p of live.predictions.values()) {
    if (p.paused) continue;
    keep.add(learningKey(p.productId, p.scope));
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
      .values({ householdId: household.id, productId: p.productId, scope: p.scope, ownerMemberId: p.ownerMemberId, ...values })
      .onConflictDoUpdate({
        target: [predictions.householdId, predictions.productId, predictions.scope],
        targetWhere: sql`${predictions.productId} is not null`,
        set: values,
      });
  }
  const stored = await db
    .select({ id: predictions.id, productId: predictions.productId, scope: predictions.scope })
    .from(predictions)
    .where(eq(predictions.householdId, household.id));
  const stale = stored.filter((row) => !row.productId || !keep.has(learningKey(row.productId, row.scope))).map((row) => row.id);
  if (stale.length > 0) await db.delete(predictions).where(inArray(predictions.id, stale));
}

/** Recompute learning for touched products, then refresh stored predictions. */
export async function refreshLearning(
  db: Queryable,
  household: LearningHousehold,
  productIds: Array<string | null>,
  now: Date,
): Promise<void> {
  const ids = productIds.filter((id): id is string => Boolean(id));
  if (ids.length > 0) {
    const index = await loadProductIndex(db, household.id);
    await refreshProductStats(db, household, ids, index, now);
  }
  if (!household.individualPatterns) {
    // Individual patterns aren't part of this plan: their stored numbers would only go stale.
    await db
      .delete(consumptionStats)
      .where(and(eq(consumptionStats.householdId, household.id), sql`${consumptionStats.scope} like 'member:%'`));
  }
  const live = await computeLiveState(db, household, now);
  await persistPredictions(db, household, live);
}
