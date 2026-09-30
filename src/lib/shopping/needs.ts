/**
 * Smart shopping needs: everything Plenty thinks should be bought at the next
 * shop, and why.
 *
 * Three deterministic sources feed it:
 *   - meal plan: shortfalls from `computePlanRequirements`, already net of
 *     what's in the kitchen;
 *   - predicted: products forecast to run out before the shop after next,
 *     with enough to last until then — or, for perishables, only as much
 *     as will be used before it goes off;
 *   - staples: regular buys the household has none of and is due to buy.
 *
 * Needs for the same item merge into one line: raw amounts add up in the
 * product's unit and are rounded to packages once, the strongest source
 * leads, and the reasons are kept side by side. Products the household
 * throws out get a smaller suggestion and a gentle note.
 *
 * Pure and deterministic.
 */

import type { ProductInfo } from "@/lib/catalog/types";
import { daysBetween } from "@/lib/dates";
import { AISLE_ORDER, type Aisle, type ShoppingSource } from "@/lib/domain";
import { convertForProduct, roundQuantity } from "@/lib/meals/matching";
import { purchaseIncrement, roundUpToPurchase } from "@/lib/meals/requirements";
import type { MissingIngredient, PredictionInput, ShoppingNeed, ShoppingNeedSource, StapleInput } from "@/lib/meals/types";
import { OUT_NOW_MAX_DAYS, TODAY_MAX_DAYS, formatDaysRemaining } from "@/lib/prediction/labels";
import { shoppingItemKey } from "@/lib/shopping/keys";
import { convert, unitDimension, type Unit } from "@/lib/units";

// ─── Tunables ───────────────────────────────────────────────────────────────

/** A staple with no stock is due again once this share of its usual interval has passed. */
export const STAPLE_DUE_INTERVAL_SHARE = 0.8;
/** Waste advice needs at least this many wasted batches… */
export const WASTE_ADVICE_MIN_EVENTS = 2;
/** …and at least this share of the product thrown out. */
export const WASTE_ADVICE_MIN_RATIO = 0.25;
/** Never shrink a suggestion by more than this share for waste. */
const MAX_WASTE_REDUCTION = 0.9;

export const WASTE_ADVICE_SMALLER = "You often throw some of this out — this is a smaller amount than usual.";
export const WASTE_ADVICE_SMALLEST = "You often throw some of this out — the smallest pack should do.";
/** Shown when a predicted amount was limited to what keeps (12 bananas for a fortnight would go brown). */
export const FRESHNESS_ADVICE = "Just what you'll use while it's fresh — top up later if you run low.";

type NeedSource = Exclude<ShoppingSource, "manual">;

/** Lower comes first: a meal-plan need outranks a prediction, which outranks a staple. */
const SOURCE_PRIORITY: Record<NeedSource, number> = { meal_plan: 0, predicted: 1, staple: 2 };

const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

export interface WasteStats {
  wasteRatio: number;
  wasteEvents: number;
}

export interface ShoppingNeedsInput {
  predictions: readonly PredictionInput[];
  planMissing: readonly MissingIngredient[];
  staples: readonly StapleInput[];
  products: ReadonlyMap<string, ProductInfo>;
  /** Waste history keyed by productId. */
  waste: ReadonlyMap<string, WasteStats>;
  /** Days until the shop after next: anything running out within it is bought now. */
  horizonDays: number;
  now: Date;
}

/** One source's view of an item before merging. */
interface Contribution {
  itemKey: string;
  productId: string | null;
  name: string;
  aisle: Aisle;
  source: NeedSource;
  /** Amount wanted before package rounding, in `unit`; null = "one of the usual". */
  amount: number | null;
  unit: Unit | null;
  /** Predicted and staple amounts can be trimmed for waste; meal-plan amounts are exact. */
  wasteAdjustable: boolean;
  /** The amount was limited to what will be used before the product goes off. */
  freshnessLimited: boolean;
  reason: string;
  sources: ShoppingNeedSource[];
}

// ─── Wording ────────────────────────────────────────────────────────────────

/** "Likely to run out in about 2 days", "Likely to run out today", "You've probably run out". */
export function runOutReason(prediction: Pick<PredictionInput, "daysRemaining" | "daysLow" | "daysHigh" | "confidence">): string {
  const days = prediction.daysRemaining;
  if (!(days > OUT_NOW_MAX_DAYS)) return "You've probably run out";
  if (days < TODAY_MAX_DAYS) return "Likely to run out today";
  const label = formatDaysRemaining(days, { low: prediction.daysLow, high: prediction.daysHigh, confidence: prediction.confidence });
  if (label.startsWith("up to ")) return `Likely to run out within ${label.slice("up to ".length)}`;
  return `Likely to run out in ${label}`;
}

/** "every day", "every 4 days", "every week", "every 2 weeks", "every month", "every 2 months". */
function intervalPhrase(days: number): string {
  if (days < 1.5) return "every day";
  if (days < 6.5) return `every ${Math.round(days)} days`;
  if (days < 10) return "every week";
  if (days < 26) return `every ${Math.round(days / DAYS_PER_WEEK)} weeks`;
  if (days < 45) return "every month";
  return `every ${Math.round(days / DAYS_PER_MONTH)} months`;
}

/** "You usually buy this every week", or a plainer line when the rhythm isn't known yet. */
export function stapleReason(typicalIntervalDays: number | null): string {
  if (typicalIntervalDays === null || !(typicalIntervalDays > 0)) return "You buy this regularly and you're out";
  return `You usually buy this ${intervalPhrase(typicalIntervalDays)}`;
}

// ─── Contributions ──────────────────────────────────────────────────────────

function lookupProduct(products: ReadonlyMap<string, ProductInfo>, productId: string | null): ProductInfo | null {
  return productId ? products.get(productId) ?? null : null;
}

/** A base-unit amount in the product's unit, or as-is for unknown products. */
function fromBase(amountBase: number | null, baseUnit: Unit, product: ProductInfo | null): { amount: number | null; unit: Unit } {
  if (!product) return { amount: amountBase !== null && amountBase > 0 ? amountBase : null, unit: baseUnit };
  if (amountBase === null) return { amount: null, unit: product.unit };
  return { amount: convertForProduct(amountBase, baseUnit, product.unit, product), unit: product.unit };
}

/** What this contribution alone would buy — shown on its source row. */
function standalonePurchase(amount: number | null, unit: Unit | null, product: ProductInfo | null): number | null {
  if (product) return amount === null || unit !== product.unit ? purchaseIncrement(product) : roundUpToPurchase(amount, product);
  return amount === null ? null : roundFreeText(amount, unit);
}

/** The prediction's own item key, falling back to the standard one. */
function predictionKey(prediction: PredictionInput): string {
  return prediction.itemKey || shoppingItemKey({ productId: prediction.productId, name: prediction.name });
}

/**
 * How many days of use a purchase can sensibly cover: all of `coverDays`,
 * except that a perishable (not kept frozen) is bought for no longer than it
 * keeps — two loaves now and another later beats four going stale.
 */
function freshCoverDays(product: ProductInfo | null, coverDays: number): number {
  if (!product || !product.perishable || product.location === "freezer") return coverDays;
  const shelfLife = product.shelfLifeDays;
  return typeof shelfLife === "number" && shelfLife > 0 ? Math.min(coverDays, shelfLife) : coverDays;
}

function predictedContribution(prediction: PredictionInput, product: ProductInfo | null, horizonDays: number): Contribution | null {
  // Enough at home to last past the shop after next: not needed.
  if (!(prediction.daysRemaining <= horizonDays)) return null;
  const coverDays = Math.max(0, horizonDays - Math.max(0, prediction.daysRemaining));
  const freshDays = freshCoverDays(product, coverDays);
  const { amount, unit } = fromBase(Math.max(0, prediction.dailyRate) * freshDays, prediction.baseUnit, product);
  const reason = runOutReason(prediction);
  return {
    itemKey: predictionKey(prediction),
    productId: prediction.productId,
    name: prediction.name,
    aisle: prediction.aisle,
    source: "predicted",
    amount,
    unit,
    wasteAdjustable: true,
    freshnessLimited: freshDays < coverDays,
    reason,
    sources: [{ source: "predicted", quantity: standalonePurchase(amount, unit, product), unit, note: reason }],
  };
}

function isStapleDue(staple: StapleInput, now: Date): boolean {
  if (staple.lastPurchasedAt === null || staple.typicalIntervalDays === null || !(staple.typicalIntervalDays > 0)) return true;
  return daysBetween(staple.lastPurchasedAt, now) >= STAPLE_DUE_INTERVAL_SHARE * staple.typicalIntervalDays;
}

function stapleContribution(staple: StapleInput, product: ProductInfo | null, now: Date): Contribution | null {
  if (staple.hasActiveStock || !isStapleDue(staple, now)) return null;
  const { amount, unit } = fromBase(staple.typicalPurchaseAmount, staple.baseUnit, product);
  const reason = stapleReason(staple.typicalIntervalDays);
  return {
    itemKey: shoppingItemKey({ productId: staple.productId, name: staple.name }),
    productId: staple.productId,
    name: staple.name,
    aisle: staple.aisle,
    source: "staple",
    amount,
    unit,
    wasteAdjustable: true,
    freshnessLimited: false,
    reason,
    sources: [{ source: "staple", quantity: standalonePurchase(amount, unit, product), unit, note: reason }],
  };
}

function mealPlanContribution(missing: MissingIngredient, product: ProductInfo | null): Contribution {
  // Prefer the raw shortfall so merged needs round to packages once, not twice.
  const raw =
    product && missing.shortfallQuantity !== null && missing.unit !== null
      ? convertForProduct(missing.shortfallQuantity, missing.unit, product.unit, product)
      : null;
  const amount = raw ?? missing.purchaseQuantity;
  const unit = raw !== null && product ? product.unit : missing.purchaseUnit;
  const planItemIds = missing.forPlanItemIds.length > 0 ? missing.forPlanItemIds : [undefined];
  return {
    itemKey: shoppingItemKey({ productId: missing.productId, name: missing.name }),
    productId: missing.productId,
    name: missing.name,
    aisle: missing.aisle,
    source: "meal_plan",
    amount,
    unit,
    wasteAdjustable: false,
    freshnessLimited: false,
    reason: missing.reason,
    // One source per plan item (so it disappears with that meal); the line's quantity rides on the first.
    sources: planItemIds.map((mealPlanItemId, i) => ({
      source: "meal_plan" as const,
      quantity: i === 0 ? missing.purchaseQuantity : null,
      unit: i === 0 ? missing.purchaseUnit : null,
      note: missing.reason,
      ...(mealPlanItemId ? { mealPlanItemId } : {}),
    })),
  };
}

// ─── Merging ────────────────────────────────────────────────────────────────

function roundFreeText(amount: number, unit: Unit | null): number {
  if (unit === null || unitDimension(unit) === "count") return Math.max(1, Math.ceil(amount - 1e-9));
  return roundQuantity(amount);
}

function wasteFactorFor(stats: WasteStats | undefined): number | null {
  if (!stats || stats.wasteEvents < WASTE_ADVICE_MIN_EVENTS || !(stats.wasteRatio >= WASTE_ADVICE_MIN_RATIO)) return null;
  return 1 - Math.min(MAX_WASTE_REDUCTION, stats.wasteRatio);
}

/** Sum of contribution amounts in `unit`, scaling waste-adjustable ones by `wasteFactor`. */
function totalIn(
  contributions: readonly Contribution[],
  unit: Unit,
  product: ProductInfo | null,
  wasteFactor: number,
): number {
  let total = 0;
  for (const c of contributions) {
    if (c.amount === null || c.unit === null) continue;
    const converted = product ? convertForProduct(c.amount, c.unit, unit, product) : convert(c.amount, c.unit, unit);
    if (converted === null) continue;
    total += c.wasteAdjustable ? converted * wasteFactor : converted;
  }
  return total;
}

interface MergedQuantity {
  quantity: number | null;
  unit: Unit | null;
  advice?: string;
}

function mergeKnownProduct(contributions: readonly Contribution[], product: ProductInfo, wasteFactor: number | null): MergedQuantity {
  const usual = roundUpToPurchase(totalIn(contributions, product.unit, product, 1), product);
  if (wasteFactor === null || !contributions.some((c) => c.wasteAdjustable)) return { quantity: usual, unit: product.unit };
  const trimmed = roundUpToPurchase(totalIn(contributions, product.unit, product, wasteFactor), product);
  if (trimmed < usual) return { quantity: trimmed, unit: product.unit, advice: WASTE_ADVICE_SMALLER };
  const onlyUsualBuys = contributions.every((c) => c.wasteAdjustable);
  const smallest = trimmed <= purchaseIncrement(product);
  return { quantity: trimmed, unit: product.unit, ...(onlyUsualBuys && smallest ? { advice: WASTE_ADVICE_SMALLEST } : {}) };
}

function mergeFreeText(contributions: readonly Contribution[], wasteFactor: number | null): MergedQuantity {
  const lead = contributions.find((c) => c.amount !== null && c.unit !== null);
  if (!lead || lead.unit === null) return { quantity: null, unit: null };
  const total = totalIn(contributions, lead.unit, null, wasteFactor ?? 1);
  return { quantity: roundFreeText(total, lead.unit), unit: lead.unit };
}

function mergeGroup(
  contributions: readonly Contribution[],
  products: ReadonlyMap<string, ProductInfo>,
  waste: ReadonlyMap<string, WasteStats>,
): ShoppingNeed {
  const ordered = [...contributions].sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
  const lead = ordered[0];
  const productId = ordered.find((c) => c.productId !== null)?.productId ?? null;
  const product = lookupProduct(products, productId);
  const wasteFactor = productId ? wasteFactorFor(waste.get(productId)) : null;
  const merged = product ? mergeKnownProduct(ordered, product, wasteFactor) : mergeFreeText(ordered, wasteFactor);
  const advice = merged.advice ?? (ordered.some((c) => c.freshnessLimited) ? FRESHNESS_ADVICE : undefined);
  return {
    itemKey: lead.itemKey,
    productId,
    name: product?.name ?? lead.name,
    aisle: product?.aisle ?? lead.aisle,
    quantity: merged.quantity,
    unit: merged.unit,
    sources: ordered.flatMap((c) => c.sources),
    primarySource: lead.source,
    reason: [...new Set(ordered.map((c) => c.reason))].join(" · "),
    ...(advice ? { advice } : {}),
  };
}

function byAisleThenName(a: ShoppingNeed, b: ShoppingNeed): number {
  const aisle = AISLE_ORDER.indexOf(a.aisle) - AISLE_ORDER.indexOf(b.aisle);
  if (aisle !== 0) return aisle;
  const nameA = a.name.toLowerCase();
  const nameB = b.name.toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Everything to buy at the next shop, one need per item key, in aisle order.
 *
 * - Meal plan: each `planMissing` line (already net of inventory), keeping
 *   its plan item ids in the sources.
 * - Predicted: products whose `daysRemaining` ≤ `horizonDays`, with enough to
 *   cover usage until the shop after next (at least one package) — capped,
 *   for perishables not kept frozen, at their shelf life's worth of use, with
 *   FRESHNESS_ADVICE. Products predicted to last longer are left off — the
 *   household has enough.
 * - Staples: no active stock, not tracked by a prediction, and due (no known
 *   rhythm, or ≥ 80% of the usual interval since the last purchase) — one
 *   typical purchase.
 *
 * Needs for the same key merge: amounts add up when units convert, the
 * strongest source leads (meal plan > predicted > staple), and distinct
 * reasons are joined with " · ". With a waste history (≥ 2 events and ≥ 25%
 * wasted), predicted and staple amounts shrink by the waste ratio (never
 * below one purchasable unit) and the need carries advice.
 */
export function computeShoppingNeeds(input: ShoppingNeedsInput): ShoppingNeed[] {
  const contributions: Contribution[] = [];
  for (const missing of input.planMissing) {
    contributions.push(mealPlanContribution(missing, lookupProduct(input.products, missing.productId)));
  }
  // Products with a prediction are handled by it, whether or not it says to buy now.
  const predicted = new Set<string>();
  for (const prediction of input.predictions) {
    predicted.add(predictionKey(prediction));
    if (prediction.productId) predicted.add(shoppingItemKey({ productId: prediction.productId, name: prediction.name }));
    const contribution = predictedContribution(prediction, lookupProduct(input.products, prediction.productId), input.horizonDays);
    if (contribution) contributions.push(contribution);
  }
  for (const staple of input.staples) {
    if (predicted.has(shoppingItemKey({ productId: staple.productId, name: staple.name }))) continue;
    const contribution = stapleContribution(staple, lookupProduct(input.products, staple.productId), input.now);
    if (contribution) contributions.push(contribution);
  }

  const groups = new Map<string, Contribution[]>();
  for (const contribution of contributions) {
    const group = groups.get(contribution.itemKey);
    if (group) group.push(contribution);
    else groups.set(contribution.itemKey, [contribution]);
  }
  return [...groups.values()].map((group) => mergeGroup(group, input.products, input.waste)).sort(byAisleThenName);
}
