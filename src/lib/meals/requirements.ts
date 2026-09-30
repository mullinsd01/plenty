/**
 * Meal-plan requirements: what the planned meals need that the kitchen
 * doesn't already have.
 *
 * Meals are processed in date order against a working copy of inventory, so
 * each one claims real stock (soonest-expiring first, exact products before
 * substitutes, nothing that will have expired by the meal's date) and two
 * meals can never both count the same 500 g of mince. Whatever is still short
 * is aggregated per product across the week, converted to the product's
 * tracking unit, and rounded up to what can actually be bought.
 *
 * This is the deterministic, explainable calculation behind the shopping
 * list: every line says exactly which meals it is for.
 *
 * Pure and deterministic.
 */

import type { ProductInfo } from "@/lib/catalog/types";
import { WEEKDAY_NAMES, weekdayOf } from "@/lib/dates";
import type { Aisle } from "@/lib/domain";
import {
  allocateMealIngredients,
  convertForProduct,
  roundQuantity,
  summarizeAvailability,
  type IngredientAllocation,
  type LotBalances,
} from "@/lib/meals/matching";
import type { InventoryLot, MissingIngredient, PlanMealInput, PlanRequirementsResult } from "@/lib/meals/types";
import { sentenceCase } from "@/lib/normalize";
import { normalizeItemName } from "@/lib/shopping/keys";
import { packagesNeeded, unitDimension, type Unit } from "@/lib/units";

/** Prefix of `MissingIngredient.key` for ingredients without a product. */
export const REQUIREMENT_NAME_KEY_PREFIX = "name:";
/** Aisle for free-text ingredients Plenty can't place. */
const UNKNOWN_AISLE: Aisle = "other";

/**
 * Leading words of meal names that stay capitalised mid-sentence
 * ("For Monday's Thai green curry"). Everything else is lower-cased.
 */
const PROPER_LEADING_WORDS = new Set([
  "american",
  "asian",
  "australian",
  "aussie",
  "balinese",
  "british",
  "cajun",
  "chinese",
  "english",
  "filipino",
  "french",
  "greek",
  "hainanese",
  "hawaiian",
  "indian",
  "indonesian",
  "irish",
  "italian",
  "jamaican",
  "japanese",
  "korean",
  "lebanese",
  "malaysian",
  "mediterranean",
  "mexican",
  "middle",
  "moroccan",
  "persian",
  "scottish",
  "sichuan",
  "singapore",
  "spanish",
  "thai",
  "turkish",
  "tuscan",
  "vietnamese",
]);

export interface PlanRequirementsInput {
  items: readonly PlanMealInput[];
  lots: readonly InventoryLot[];
  products: ReadonlyMap<string, ProductInfo>;
}

// ─── Purchase rounding ──────────────────────────────────────────────────────

/**
 * Whether a product is bought by the piece rather than by the pack: produce
 * tracked as "each" (onions, lemons, avocados) is sold loose, so needing two
 * onions means buying two, not a 6-pack.
 */
export function isSoldLoose(product: ProductInfo): boolean {
  return product.aisle === "produce" && product.unit === "each";
}

/** The smallest amount of a product that can be bought, in `product.unit`. */
export function purchaseIncrement(product: ProductInfo): number {
  if (isSoldLoose(product)) return 1;
  return product.packageQuantity > 0 ? product.packageQuantity : 1;
}

/**
 * Round a needed amount (in `product.unit`) up to whole purchasable units —
 * packages, or single pieces for loose produce. Always at least one.
 * 150 ml cream (300 ml pack) → 300; 3 eggs (dozen) → 12; 2 onions → 2.
 */
export function roundUpToPurchase(amount: number, product: ProductInfo): number {
  const increment = purchaseIncrement(product);
  // Round away float noise first so 2.0000001 onions doesn't become 3.
  return roundQuantity(packagesNeeded(roundQuantity(Math.max(0, amount)), increment) * increment);
}

/**
 * What to buy for an ingredient Plenty has no product for: the shortfall
 * as-is, whole items for counted units, or one item when unquantified.
 */
function freeTextPurchase(quantity: number | null, unit: Unit | null): { quantity: number; unit: Unit } {
  if (quantity === null || unit === null || !(quantity > 0)) return { quantity: 1, unit: "each" };
  if (unitDimension(unit) === "count") return { quantity: Math.max(1, Math.ceil(quantity - 1e-9)), unit };
  return { quantity: roundQuantity(quantity), unit };
}

// ─── Keys and wording ───────────────────────────────────────────────────────

/** `MissingIngredient.key`: the productId, or "name:<normalised singular name>". */
export function requirementKey(productId: string | null, name: string): string {
  return productId ?? `${REQUIREMENT_NAME_KEY_PREFIX}${normalizeItemName(name)}`;
}

function mealNameInSentence(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const first = trimmed.split(" ")[0] ?? "";
  const isAcronym = first.length > 1 && first === first.toUpperCase() && /[A-Z]/.test(first);
  if (isAcronym || PROPER_LEADING_WORDS.has(first.toLowerCase())) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

interface PlanRef {
  planItemId: string;
  date: string;
  mealName: string;
}

/** "For Monday's chicken curry and Wednesday's beef tacos". */
function planReason(plans: readonly PlanRef[]): string {
  const phrases = plans.map((p) => `${WEEKDAY_NAMES[weekdayOf(p.date)]}'s ${mealNameInSentence(p.mealName)}`);
  return `For ${joinWithAnd([...new Set(phrases)])}`;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

interface Shortfall {
  key: string;
  productId: string | null;
  product: ProductInfo | null;
  name: string;
  quantity: number | null;
  unit: Unit | null;
  plan: PlanRef;
}

interface Line {
  key: string;
  productId: string | null;
  product: ProductInfo | null;
  name: string;
  aisle: Aisle;
  quantity: number | null;
  unit: Unit | null;
  plans: PlanRef[];
}

/** The shortfall in the product's tracking unit when convertible, else as the recipe wrote it. */
function inTrackingUnit(quantity: number | null, unit: Unit | null, product: ProductInfo | null): { quantity: number | null; unit: Unit | null } {
  if (quantity === null || unit === null || !product) return { quantity, unit };
  const converted = convertForProduct(quantity, unit, product.unit, product);
  return converted === null ? { quantity, unit } : { quantity: converted, unit: product.unit };
}

function toShortfall(allocation: IngredientAllocation, plan: PlanRef): Shortfall {
  const { ingredient, product, availability } = allocation;
  const quantity = inTrackingUnit(allocation.shortfallQuantity, availability.unit, product);
  return {
    key: requirementKey(ingredient.productId, ingredient.name),
    productId: ingredient.productId,
    product,
    name: product?.name ?? sentenceCase(ingredient.name),
    quantity: quantity.quantity,
    unit: quantity.unit,
    plan,
  };
}

function addPlan(line: Line, plan: PlanRef): void {
  if (!line.plans.some((p) => p.planItemId === plan.planItemId)) line.plans.push(plan);
}

function newLine(shortfall: Shortfall, quantity: number | null, unit: Unit | null): Line {
  return {
    key: shortfall.key,
    productId: shortfall.productId,
    product: shortfall.product,
    name: shortfall.name,
    aisle: shortfall.product?.aisle ?? UNKNOWN_AISLE,
    quantity,
    unit,
    plans: [shortfall.plan],
  };
}

/**
 * Fold a shortfall into the running lines. Same key and convertible units add
 * up; unconvertible units stay on their own line (never apples plus litres);
 * an unquantified need rides along with any line for the same key.
 */
function addShortfall(lines: Line[], shortfall: Shortfall): void {
  const sameKey = lines.filter((line) => line.key === shortfall.key);
  if (shortfall.quantity === null || shortfall.unit === null) {
    if (sameKey[0]) addPlan(sameKey[0], shortfall.plan);
    else lines.push(newLine(shortfall, null, shortfall.product?.unit ?? null));
    return;
  }
  for (const line of sameKey) {
    if (line.quantity === null || line.unit === null) {
      line.quantity = shortfall.quantity;
      line.unit = shortfall.unit;
      addPlan(line, shortfall.plan);
      return;
    }
    const converted = convertForProduct(shortfall.quantity, shortfall.unit, line.unit, shortfall.product);
    if (converted !== null) {
      line.quantity += converted;
      addPlan(line, shortfall.plan);
      return;
    }
  }
  lines.push(newLine(shortfall, shortfall.quantity, shortfall.unit));
}

function purchaseFor(line: Line): { quantity: number; unit: Unit } {
  const product = line.product;
  if (!product) return freeTextPurchase(line.quantity, line.unit);
  if (line.quantity !== null && line.unit === product.unit) {
    return { quantity: roundUpToPurchase(line.quantity, product), unit: product.unit };
  }
  // Unknown or unconvertible amount: one pack is the honest suggestion.
  return { quantity: purchaseIncrement(product), unit: product.unit };
}

function toMissing(line: Line): MissingIngredient {
  const purchase = purchaseFor(line);
  return {
    key: line.key,
    productId: line.productId,
    name: line.name,
    aisle: line.aisle,
    shortfallQuantity: line.quantity === null ? null : roundQuantity(line.quantity),
    unit: line.unit,
    purchaseQuantity: purchase.quantity,
    purchaseUnit: purchase.unit,
    forPlanItemIds: line.plans.map((p) => p.planItemId),
    reason: planReason(line.plans),
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────

/** Plan items in cooking order: by date, then by input order. */
function chronological(items: readonly PlanMealInput[]): Array<{ item: PlanMealInput; index: number }> {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.date < b.item.date ? -1 : a.item.date > b.item.date ? 1 : a.index - b.index));
}

/**
 * What a meal plan needs to buy, net of the kitchen.
 *
 * Meals claim inventory chronologically (see module doc), so availability
 * per meal reflects what earlier meals have already used. Required
 * ingredients that are missing or only partly covered (< 75%) become
 * shortfalls, aggregated per product (or normalised name) across meals in
 * the product's tracking unit, and rounded up to whole packages (loose
 * produce by the piece). Unquantified missing items buy one package.
 * Assumed basics and optional ingredients never generate lines.
 * `meals` is returned in input order; `missing` in order of first need.
 */
export function computePlanRequirements(input: PlanRequirementsInput): PlanRequirementsResult {
  const balances: LotBalances = new Map();
  const allocations: IngredientAllocation[][] = new Array(input.items.length);
  const lines: Line[] = [];

  for (const { item, index } of chronological(input.items)) {
    const allocated = allocateMealIngredients(item.meal, input.lots, input.products, { servings: item.servings, date: item.date }, balances);
    allocations[index] = allocated;
    const plan: PlanRef = { planItemId: item.planItemId, date: item.date, mealName: item.meal.name };
    for (const allocation of allocated) {
      if (allocation.needsPurchase) addShortfall(lines, toShortfall(allocation, plan));
    }
  }

  const meals = input.items.map((item, index) => {
    const ingredients = (allocations[index] ?? []).map((a) => a.availability);
    const summary = summarizeAvailability(ingredients);
    return {
      planItemId: item.planItemId,
      ingredients,
      haveCount: summary.haveCount,
      missingCount: summary.missingCount,
      allAvailable: summary.missingCount === 0,
    };
  });

  return { meals, missing: lines.map(toMissing) };
}
