/**
 * End-to-end simulation of Plenty's product loop, entirely through the pure
 * engines: a Woolworths receipt is read and normalised into inventory, six
 * weeks of household history teach Plenty how fast milk, bread and eggs go,
 * run-outs are predicted, three dinners are planned from the kitchen, and the
 * shopping list is rebuilt and reconciled with the one the household already
 * has. Every stage asserts what the next one relies on.
 */

import { describe, expect, it } from "vitest";
import { CATALOG, productInfoFromCatalog, type ProductInfo } from "@/lib/catalog";
import { computeConsumptionStats } from "@/lib/consumption/stats";
import type { BatchState, ConsumptionObservation, ConsumptionStats, PurchaseObservation, RunOutPrediction } from "@/lib/consumption/types";
import { addDays, DAY_MS, daysBetweenDates, toDateString, weekdayOf } from "@/lib/dates";
import { adultEquivalents, CONFIDENCE_LEVELS, type Confidence } from "@/lib/domain";
import { computeShoppingRhythm, shoppingHorizonDays } from "@/lib/insights";
import {
  computePlanRequirements,
  defaultServings,
  generatePlan,
  isMealAllowed,
  libraryPlannableMeals,
  convertForProduct,
  lotRemaining,
  type ExistingListItem,
  type InventoryLot,
  type PlannerContext,
  type PlannerPreferences,
  type PredictionInput,
} from "@/lib/meals";
import { ACCEPT_MATCH_SCORE, normalizeReceiptLine, type NormalizedReceiptLine } from "@/lib/normalize";
import { predictRunOut, type PredictionStats } from "@/lib/prediction/engine";
import { estimateExpiry } from "@/lib/prediction/expiry";
import { parseReceiptText, sumReceiptLines, type ParsedReceiptLine } from "@/lib/receipts/parse";
import { computeShoppingNeeds, FRESHNESS_ADVICE, reconcileShoppingList, shoppingItemKey } from "@/lib/shopping";
import { convert, productBaseUnit, toBaseUnit, type BaseUnit, type Unit } from "@/lib/units";

// ─── The household ──────────────────────────────────────────────────────────

const TIME_ZONE = "Australia/Sydney";
/** Two adults and a child: 2.6 adult-equivalents. */
const HOUSEHOLD_SIZE = adultEquivalents(2, 1);
/** Monday 28 September 2026, 6 pm in Sydney (AEST, UTC+10): planning the week's dinners. */
const NOW = new Date("2026-09-28T08:00:00Z");
const TODAY = toDateString(NOW, TIME_ZONE);
/** The big weekly shop: Sunday 27 September, 10:15 am. */
const RECEIPT_AT = new Date("2026-09-27T00:15:00Z");

const PRODUCTS: ReadonlyMap<string, ProductInfo> = new Map(CATALOG.map((p) => [p.slug, productInfoFromCatalog(p)]));

function product(slug: string): ProductInfo {
  const found = PRODUCTS.get(slug);
  if (!found) throw new Error(`No catalog product ${slug}`);
  return found;
}

function baseUnitOf(p: ProductInfo): BaseUnit {
  return productBaseUnit(p, p.unit);
}

function toBase(p: ProductInfo, quantity: number, unit: Unit): number {
  const amount = toBaseUnit(quantity, unit, baseUnitOf(p), p);
  if (amount === null) throw new Error(`Can't express ${quantity} ${unit} of ${p.slug} in ${baseUnitOf(p)}`);
  return amount;
}

// ─── Stage 1: the receipt ───────────────────────────────────────────────────

const RECEIPT_TEXT = `
               WOOLWORTHS
     Woolworths Marrickville Metro
       34 Victoria Rd Marrickville
          Marrickville NSW 2204
           Ph: (02) 9000 4321
           ABN 88 000 014 675
              TAX INVOICE
----------------------------------------
W/M FULL CREAM 2L
  2 @ $3.10 EACH                    6.20
WW WHITE BREAD 700G                 2.70
WW FREE RANGE EGGS 12PK             6.20
WW CHICKEN BREAST FILLET 1KG       12.00
WW BEEF MINCE 500G                  6.50
WW BABY SPINACH 120G                3.00
SAN REMO SPAGHETTI 500G
  2 @ $2.00 EACH                    4.00
MUTTI PASSATA 700G                  3.50
  LESS SPECIAL                     -1.00
BANANAS KG
  0.842 kg NET @ $3.90/kg           3.28
CAPSICUM RED EACH                   1.90
ZUCCHINI GREEN KG
  0.386 kg NET @ $5.90/kg           2.28
CORIANDER BUNCH                     3.00
DAIRY FARMERS YOGHURT 1KG           7.00
BEGA TASTY CHEESE 500G              9.00
CARRY BAG                           0.15
----------------------------------------
15 SUBTOTAL                       $69.71
TOTAL                             $69.71
EFTPOS                            $69.71
Total includes GST                 $0.01
----------------------------------------
YOU SAVED                          $1.00
27/09/2026 10:15  STORE 1234  LANE 5
EVERYDAY REWARDS CARD ****4821
POINTS EARNED THIS SHOP               69

     THANK YOU FOR SHOPPING WITH US
`;

interface Purchase {
  line: ParsedReceiptLine;
  normalized: NormalizedReceiptLine;
  product: ProductInfo;
  /** Amount bought in the product's tracking unit. */
  quantity: number;
}

/**
 * What a confirmed receipt line puts in the kitchen: the normaliser's amount
 * for one item, times the "2 @ $x" count, or the printed weight for weighed
 * produce converted into the product's tracking unit.
 */
function purchaseFrom(line: ParsedReceiptLine, normalized: NormalizedReceiptLine, p: ProductInfo): number {
  if (line.weightKg !== null) {
    const converted = convert(line.weightKg, "kg", p.unit, p);
    if (converted === null) throw new Error(`Can't weigh ${p.slug}`);
    return p.unit === "each" ? Math.max(1, Math.round(converted)) : converted;
  }
  const items = line.quantity !== null && Number.isInteger(line.quantity) && line.quantity > 1 ? line.quantity : 1;
  const single = normalized.unit === p.unit ? normalized.quantity : convert(normalized.quantity, normalized.unit, p.unit, p);
  if (single === null) throw new Error(`Can't express ${normalized.unit} of ${p.slug} in ${p.unit}`);
  return single * items;
}

const receipt = parseReceiptText(RECEIPT_TEXT, { today: TODAY });
const normalizedLines = receipt.lines.map((line) => normalizeReceiptLine(line.description));
const purchases: Purchase[] = receipt.lines.flatMap((line, i) => {
  const normalized = normalizedLines[i];
  if (!normalized.isFood || !normalized.match || normalized.match.score < ACCEPT_MATCH_SCORE) return [];
  const p = product(normalized.match.product.slug);
  return [{ line, normalized, product: p, quantity: purchaseFrom(line, normalized, p) }];
});
const purchased = new Map(purchases.map((entry) => [entry.product.slug, entry]));

// ─── Stage 2: inventory with expiry estimates ───────────────────────────────

function lotFor(id: string, p: ProductInfo, quantity: number, purchasedAt: Date, remainingFraction = 1): InventoryLot {
  return {
    id,
    productId: p.id,
    name: p.name,
    quantity,
    unit: p.unit,
    remainingFraction,
    expiresOn: estimateExpiry({
      purchasedAt,
      shelfLifeDays: p.shelfLifeDays,
      freezerShelfLifeDays: p.freezerShelfLifeDays,
      location: p.location,
      perishable: p.perishable,
      timeZone: TIME_ZONE,
    }),
    location: p.location,
  };
}

const receiptLots: InventoryLot[] = purchases.map((entry) => lotFor(`receipt-${entry.product.slug}`, entry.product, entry.quantity, RECEIPT_AT));

/** Long-life basics already in the cupboard from earlier shops, as whole packages. */
const PANTRY_BOUGHT_AT = new Date("2026-09-06T00:30:00Z");

function pantryLot(slug: string, remainingFraction: number, packs = 1): InventoryLot {
  const p = product(slug);
  return lotFor(`pantry-${slug}`, p, p.packageQuantity * packs, PANTRY_BOUGHT_AT, remainingFraction);
}

const pantryLots: InventoryLot[] = [
  pantryLot("olive-oil", 0.7),
  pantryLot("vegetable-oil", 0.8),
  pantryLot("garlic", 1, 2),
  pantryLot("brown-onion", 0.8),
  pantryLot("soy-sauce", 0.6),
  pantryLot("jasmine-rice", 0.7, 2),
  pantryLot("basmati-rice", 0.9),
  pantryLot("smoked-paprika", 0.8),
  pantryLot("ground-cumin", 0.8),
  pantryLot("dried-oregano", 0.8),
  pantryLot("tomato-paste", 1),
  pantryLot("parmesan", 0.6),
];

// ─── Stage 3: six weeks of history for milk, bread and eggs ─────────────────

interface Lifecycle {
  purchasedAt: Date;
  observation: ConsumptionObservation;
}

/** Deterministic day-to-day variation in how fast things go (±7%). */
const RATE_JITTER = [1.04, 0.95, 1.02, 0.97, 1.06, 0.93, 1.0, 1.03, 0.96, 1.05, 0.98, 1.01];

interface HistorySpec {
  slug: string;
  /** How fast this household really gets through it, in base units per day. */
  trueDailyRate: number;
  /** One purchase, in base units. */
  batchBase: number;
  lifecycles: number;
  /** Index (oldest first) of a lifecycle that ended in the bin, with the share wasted. */
  wasted?: { index: number; wastedShare: number };
}

/**
 * Completed lifecycles ending the moment the weekly shop replaced the last
 * one, laid end to end backwards in time: each batch was bought as it was
 * opened, used at the household's (jittered) true rate, and finished — or,
 * once, partly thrown out.
 */
function simulateHistory(spec: HistorySpec, endAt: Date): Lifecycle[] {
  const lifecycles: Lifecycle[] = [];
  let end = endAt.getTime();
  for (let k = spec.lifecycles - 1; k >= 0; k--) {
    const rate = spec.trueDailyRate * RATE_JITTER[k % RATE_JITTER.length];
    const wasted = spec.wasted?.index === k ? spec.wasted.wastedShare : 0;
    const used = spec.batchBase * (1 - wasted);
    const durationDays = used / rate;
    const start = end - durationDays * DAY_MS;
    lifecycles.unshift({
      purchasedAt: new Date(start),
      observation: {
        amountUsedBase: used,
        amountWastedBase: spec.batchBase * wasted,
        durationDays,
        startedAt: new Date(start),
        endedAt: new Date(end),
        outcome: wasted > 0 ? "wasted" : "consumed",
        householdSize: HOUSEHOLD_SIZE,
      },
    });
    end = start;
  }
  return lifecycles;
}

const MILK: HistorySpec = { slug: "full-cream-milk", trueDailyRate: 750, batchBase: 2000, lifecycles: 12 };
const BREAD: HistorySpec = { slug: "white-bread", trueDailyRate: 0.3, batchBase: 1, lifecycles: 10, wasted: { index: 4, wastedShare: 0.4 } };
const EGGS: HistorySpec = { slug: "eggs", trueDailyRate: 1.5, batchBase: 12, lifecycles: 5 };
const TRACKED = [MILK, BREAD, EGGS];

const histories = new Map(TRACKED.map((spec) => [spec.slug, simulateHistory(spec, RECEIPT_AT)]));

function priorPerPerson(p: ProductInfo): number | null {
  return p.dailyUsePerPerson ? toBase(p, p.dailyUsePerPerson, p.unit) : null;
}

/** Stats as the server would compute them at `now`, from whatever had finished by then. */
function statsAt(slug: string, lifecycles: readonly Lifecycle[], now: Date, extraPurchases: PurchaseObservation[] = []): ConsumptionStats {
  const p = product(slug);
  const spec = TRACKED.find((s) => s.slug === slug);
  const known = lifecycles.filter((l) => l.observation.endedAt <= now);
  return computeConsumptionStats({
    baseUnit: baseUnitOf(p),
    observations: known.map((l) => l.observation),
    purchases: [...known.map((l) => ({ purchasedAt: l.purchasedAt, amountBase: spec?.batchBase ?? 0 })), ...extraPurchases],
    priorDailyPerPerson: priorPerPerson(p),
    householdSize: HOUSEHOLD_SIZE,
    now,
  });
}

/** The receipt's own purchase of a tracked product, as a purchase observation. */
function receiptPurchase(slug: string): PurchaseObservation[] {
  const entry = purchased.get(slug);
  return entry ? [{ purchasedAt: RECEIPT_AT, amountBase: toBase(entry.product, entry.quantity, entry.product.unit) }] : [];
}

const learned = new Map(TRACKED.map((spec) => [spec.slug, statsAt(spec.slug, histories.get(spec.slug) ?? [], NOW, receiptPurchase(spec.slug))]));

function learnedStats(slug: string): ConsumptionStats {
  const stats = learned.get(slug);
  if (!stats) throw new Error(`No learned stats for ${slug}`);
  return stats;
}

// ─── Stage 4: run-out predictions for everything in the kitchen ─────────────

function batchOf(lot: InventoryLot, purchasedAt: Date): BatchState {
  const p = product(lot.productId ?? "");
  return {
    itemId: lot.id,
    quantityBase: toBase(p, lot.quantity, lot.unit),
    knownFraction: lot.remainingFraction,
    levelUpdatedAt: purchasedAt,
    purchasedAt,
    expiresAt: null,
  };
}

interface ProductPrediction {
  product: ProductInfo;
  stats: PredictionStats;
  prediction: RunOutPrediction;
}

/** Learned stats for tracked products, Plenty's starting estimate for the rest. */
function statsFor(p: ProductInfo): ConsumptionStats {
  return learned.get(p.slug) ?? statsAt(p.slug, [], NOW);
}

const allLots = [...receiptLots, ...pantryLots];
const predictions: ProductPrediction[] = allLots.flatMap((lot) => {
  const p = product(lot.productId ?? "");
  const stats = statsFor(p);
  const purchasedAt = lot.id.startsWith("receipt-") ? RECEIPT_AT : PANTRY_BOUGHT_AT;
  const prediction = predictRunOut({ batches: [batchOf(lot, purchasedAt)], stats, productName: p.name, householdSize: HOUSEHOLD_SIZE, now: NOW });
  return prediction ? [{ product: p, stats, prediction }] : [];
});

function predictionFor(slug: string): RunOutPrediction {
  const found = predictions.find((entry) => entry.product.slug === slug);
  if (!found) throw new Error(`No prediction for ${slug}`);
  return found.prediction;
}

/** The kitchen right now: what's predicted to have been used is no longer there. */
const kitchen: InventoryLot[] = allLots.map((lot) => {
  const fraction = predictions.find((entry) => entry.prediction.batchFractions[lot.id] !== undefined)?.prediction.batchFractions[lot.id];
  return fraction === undefined ? lot : { ...lot, remainingFraction: fraction };
});

// ─── Stage 5: three dinners from the kitchen ────────────────────────────────

const PLAN_DATES = [TODAY, addDays(TODAY, 1), addDays(TODAY, 2)];
const SERVINGS = defaultServings(HOUSEHOLD_SIZE);
const PREFS: PlannerPreferences = {
  diets: [],
  allergies: [],
  dislikedIngredients: ["mushrooms"],
  favouriteCuisines: ["italian", "mexican"],
  weeknightMaxMinutes: 45,
  householdSize: HOUSEHOLD_SIZE,
  weeklyBudget: null,
};
const MEALS = libraryPlannableMeals();
const plannerContext: PlannerContext = {
  meals: MEALS,
  lots: kitchen,
  products: PRODUCTS,
  prefs: PREFS,
  history: new Map(),
  today: TODAY,
  now: NOW,
};
const plan = generatePlan(plannerContext, { dates: PLAN_DATES, servings: SERVINGS });
const plannedMeals = plan.map((item) => {
  const meal = MEALS.find((m) => m.id === item.mealId);
  if (!meal) throw new Error(`Planned an unknown meal ${item.mealId}`);
  return { item, meal };
});
const requirements = computePlanRequirements({
  items: plannedMeals.map(({ item, meal }) => ({ planItemId: `plan-${item.date}`, date: item.date, servings: SERVINGS, meal })),
  lots: kitchen,
  products: PRODUCTS,
});

// ─── Stage 6: the shopping list ─────────────────────────────────────────────

/** Weekly Sunday shops for the last six weeks, ending with this receipt. */
const SHOP_DATES = Array.from({ length: 7 }, (_, i) => addDays("2026-08-16", i * 7));
const rhythm = computeShoppingRhythm({ purchaseDates: SHOP_DATES, today: TODAY, usualShopDay: null, shopIntervalDays: null });
const horizonDays = shoppingHorizonDays(rhythm, TODAY);

const predictionInputs: PredictionInput[] = predictions.map(({ product: p, stats, prediction }) => ({
  productId: p.id,
  itemKey: shoppingItemKey({ productId: p.id, name: p.name }),
  name: p.name,
  aisle: p.aisle,
  daysRemaining: prediction.daysRemaining,
  daysLow: prediction.daysLow,
  daysHigh: prediction.daysHigh,
  confidence: prediction.confidence,
  basis: prediction.basis,
  dailyRate: prediction.dailyRate,
  baseUnit: stats.baseUnit,
}));

const needs = computeShoppingNeeds({
  predictions: predictionInputs,
  planMissing: requirements.missing,
  staples: [],
  products: PRODUCTS,
  waste: new Map(TRACKED.map((spec) => [spec.slug, learnedStats(spec.slug)])),
  horizonDays,
  now: NOW,
});

function listItem(id: string, slugOrName: string, overrides: Partial<ExistingListItem> = {}): ExistingListItem {
  const p = PRODUCTS.get(slugOrName) ?? null;
  const name = p?.name ?? slugOrName;
  return {
    id,
    itemKey: shoppingItemKey({ productId: p?.id ?? null, name }),
    productId: p?.id ?? null,
    name,
    aisle: p?.aisle ?? "other",
    quantity: null,
    unit: null,
    suggestedQuantity: null,
    suggestedUnit: null,
    source: "predicted",
    userEdited: false,
    checkedAt: null,
    dismissedUntil: null,
    purchasedAt: null,
    ...overrides,
  };
}

const SUNDAY_MORNING = new Date("2026-09-26T22:00:00Z");

/** The list as it stood on Sunday morning, before the shop. */
const existingList: ExistingListItem[] = [
  // Plenty had already flagged milk; the amount should refresh, not duplicate.
  listItem("row-milk", "full-cream-milk", { suggestedQuantity: 2, suggestedUnit: "l" }),
  // Last week's plan wanted spaghetti; Sunday's 1 kg covers this week, so Plenty's row goes.
  listItem("row-spaghetti", "spaghetti", { source: "meal_plan", suggestedQuantity: 500, suggestedUnit: "g" }),
  // The household edited this one, which makes it theirs.
  listItem("row-passata", "passata", { source: "meal_plan", suggestedQuantity: 700, suggestedUnit: "ml", quantity: 1400, unit: "ml", userEdited: true }),
  // Already in the trolley on a top-up run: left exactly as it is.
  listItem("row-bananas", "banana", { suggestedQuantity: 6, suggestedUnit: "each", checkedAt: SUNDAY_MORNING }),
  // "Not this week" on yoghurt: stays dismissed.
  listItem("row-yoghurt", "natural-yoghurt", { dismissedUntil: new Date("2026-10-04T13:00:00Z") }),
  // The household's own additions are never touched.
  listItem("row-dish-liquid", "dishwashing-liquid", { source: "manual", quantity: 1, unit: "bottle" }),
  listItem("row-birthday-candles", "Birthday candles", { source: "manual", quantity: 1, unit: "pack" }),
];
const reconciled = reconcileShoppingList(existingList, needs, NOW);

function needFor(slug: string) {
  return needs.find((need) => need.productId === slug);
}

// ─── Assertions ─────────────────────────────────────────────────────────────

function confidenceRank(confidence: Confidence): number {
  return CONFIDENCE_LEVELS.indexOf(confidence);
}

describe("Plenty's loop: receipt → kitchen", () => {
  it("reads the Woolworths receipt: store, date, totals and every item line", () => {
    expect(receipt.store).toBe("Woolworths");
    expect(receipt.purchasedOn).toBe(toDateString(RECEIPT_AT, TIME_ZONE));
    expect(receipt.total).toBe(69.71);
    expect(receipt.warnings).toEqual([]);
    expect(receipt.lines).toHaveLength(15);
    // Discounts belong to their line and the lines add up to what was paid.
    expect(sumReceiptLines(receipt.lines)).toBeCloseTo(69.71, 2);
    const passata = receipt.lines.find((l) => l.description.includes("PASSATA"));
    expect(passata).toMatchObject({ price: 2.5, discount: 1 });
    expect(receipt.lines.find((l) => l.description.startsWith("BANANAS"))?.weightKg).toBe(0.842);
  });

  it("normalises every food line to the intended catalog product with confidence", () => {
    const slugs = normalizedLines.filter((n) => n.isFood).map((n) => n.match?.product.slug);
    expect(slugs).toEqual([
      "full-cream-milk",
      "white-bread",
      "eggs",
      "chicken-breast",
      "beef-mince",
      "baby-spinach",
      "spaghetti",
      "passata",
      "banana",
      "red-capsicum",
      "zucchini",
      "coriander",
      "natural-yoghurt",
      "tasty-cheese",
    ]);
    for (const n of normalizedLines.filter((line) => line.isFood)) {
      expect(n.match?.score ?? 0, n.rawText).toBeGreaterThanOrEqual(ACCEPT_MATCH_SCORE);
    }
    const bag = normalizedLines.find((n) => n.rawText === "CARRY BAG");
    expect(bag).toMatchObject({ isFood: false, match: null });
    expect(purchases).toHaveLength(14);
  });

  it("turns lines into amounts in each product's own unit, ready for requirement maths", () => {
    const amount = (slug: string) => {
      const entry = purchased.get(slug);
      return entry ? { quantity: entry.quantity, unit: entry.product.unit } : null;
    };
    expect(amount("full-cream-milk")).toEqual({ quantity: 4, unit: "l" }); // 2 @ 2 L
    expect(amount("spaghetti")).toEqual({ quantity: 1000, unit: "g" }); // 2 @ 500 g
    expect(amount("chicken-breast")).toEqual({ quantity: 1000, unit: "g" });
    expect(amount("eggs")).toEqual({ quantity: 12, unit: "each" });
    expect(amount("white-bread")).toEqual({ quantity: 1, unit: "loaf" });
    expect(amount("banana")).toEqual({ quantity: 7, unit: "each" }); // 842 g of 120 g bananas
    expect(amount("zucchini")).toEqual({ quantity: 2, unit: "each" }); // 386 g of 200 g zucchini
    expect(amount("red-capsicum")).toEqual({ quantity: 1, unit: "each" });
    expect(amount("coriander")).toEqual({ quantity: 1, unit: "bunch" });
    // 700 g of passata is tracked by volume through its density.
    expect(amount("passata")?.unit).toBe("ml");
    expect(amount("passata")?.quantity).toBeCloseTo(700 / 1.03, 1);
    // Every amount converts to the product's base unit, so requirements can net it off.
    for (const entry of purchases) expect(toBaseUnit(entry.quantity, entry.product.unit, baseUnitOf(entry.product), entry.product)).not.toBeNull();
  });

  it("estimates expiry from the purchase day: meat first, then leaves and herbs, the pantry much later", () => {
    const expires = (id: string) => kitchen.find((lot) => lot.id === id)?.expiresOn ?? null;
    expect(expires("receipt-beef-mince")).toBe("2026-09-29");
    expect(expires("receipt-chicken-breast")).toBe("2026-09-30");
    expect(expires("receipt-baby-spinach")).toBe("2026-10-02");
    expect(expires("receipt-full-cream-milk")).toBe("2026-10-07");
    expect(expires("receipt-tasty-cheese")).toBe("2026-11-26");
    const spaghetti = expires("receipt-spaghetti");
    expect(spaghetti).not.toBeNull();
    expect(daysBetweenDates(TODAY, spaghetti ?? TODAY)).toBeGreaterThan(365);
  });
});

describe("Plenty's loop: learning and prediction", () => {
  it("moves from Plenty's estimate to the household's own history as milk is finished", () => {
    const milkHistory = histories.get(MILK.slug) ?? [];
    const checkpoints = [0, 1, 2, 3, 5, milkHistory.length].map((finished) => {
      const now = finished === 0 ? new Date(milkHistory[0].observation.startedAt.getTime() + DAY_MS / 2) : milkHistory[finished - 1].observation.endedAt;
      return { finished, stats: statsAt(MILK.slug, milkHistory, now) };
    });
    const [none, one, two, , , all] = checkpoints;

    // No history: the catalog prior (0.2 L a day per adult-equivalent) scaled to 2.6 people.
    expect(none.stats).toMatchObject({ basis: "estimate", confidence: "low", observations: 0 });
    expect(none.stats.dailyRate).toBeCloseTo(200 * HOUSEHOLD_SIZE, 6);
    // One finished bottle nudges the estimate but isn't history yet; two are.
    expect(one.stats.basis).toBe("estimate");
    expect(two.stats.basis).toBe("history");
    expect(all.stats).toMatchObject({ basis: "history", confidence: "high", observations: MILK.lifecycles, outliersExcluded: 0 });

    // Confidence only rises, and the learned rate homes in on how fast this household really drinks milk.
    const ranks = checkpoints.map((c) => confidenceRank(c.stats.confidence));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const error = (stats: ConsumptionStats) => Math.abs((stats.dailyRate ?? 0) - MILK.trueDailyRate) / MILK.trueDailyRate;
    expect(error(one.stats)).toBeLessThan(error(none.stats));
    expect(error(all.stats)).toBeLessThan(error(none.stats) / 3);
    expect(error(all.stats)).toBeLessThan(0.08);
    // Bought every few days, a staple.
    expect(learnedStats(MILK.slug).isStaple).toBe(true);
  });

  it("learns bread and eggs too, counting the loaf that went mouldy as waste but still learning from it", () => {
    const bread = learnedStats(BREAD.slug);
    expect(bread).toMatchObject({ basis: "history", wasteEvents: 1 });
    expect(bread.wasteRatio).toBeGreaterThan(0);
    expect(bread.wasteRatio).toBeLessThan(0.1);
    expect(Math.abs((bread.dailyRate ?? 0) - BREAD.trueDailyRate) / BREAD.trueDailyRate).toBeLessThan(0.1);

    const eggs = learnedStats(EGGS.slug);
    expect(eggs.basis).toBe("history");
    expect(confidenceRank(eggs.confidence)).toBeGreaterThanOrEqual(confidenceRank("medium"));
    // The family eats more eggs than the catalog guessed; Plenty now knows.
    expect(eggs.priorRate ?? 0).toBeLessThan(EGGS.trueDailyRate);
    expect(Math.abs((eggs.dailyRate ?? 0) - EGGS.trueDailyRate) / EGGS.trueDailyRate).toBeLessThan(0.15);
  });

  it("predicts the 4 L of milk runs out in about four days, with an honest label and reason", () => {
    const milk = predictionFor(MILK.slug);
    const expectedDays = (4000 - learnedStats(MILK.slug).dailyRate! * ((NOW.getTime() - RECEIPT_AT.getTime()) / DAY_MS)) / learnedStats(MILK.slug).dailyRate!;
    expect(milk.daysRemaining).toBeCloseTo(expectedDays, 6);
    expect(milk.daysRemaining).toBeGreaterThan(3.5);
    expect(milk.daysRemaining).toBeLessThan(4.5);
    expect(milk).toMatchObject({ basis: "history", confidence: "high", label: "about 4 days", needsCheckIn: false });
    expect(milk.daysLow).toBeLessThan(milk.daysRemaining);
    expect(milk.daysHigh).toBeGreaterThan(milk.daysRemaining);
    expect(milk.reason).toMatch(/2 L/);
    // It runs out before the next weekly shop.
    expect(toDateString(milk.runOutAt, TIME_ZONE) < rhythm.nextShopDate).toBe(true);
  });

  it("predicts bread and eggs from history, and untracked products from Plenty's estimate", () => {
    expect(predictionFor(BREAD.slug)).toMatchObject({ basis: "history", label: "about 2 days" });
    expect(predictionFor(EGGS.slug)).toMatchObject({ basis: "history", label: "about a week" });
    const cheese = predictionFor("tasty-cheese");
    expect(cheese.basis).toBe("estimate");
    expect(cheese.confidence).toBe("low");
    expect(cheese.reason).toMatch(/starting estimate/);
    // Products without a consumption prior (pasta, meat) get no run-out guesses.
    for (const slug of ["spaghetti", "beef-mince", "chicken-breast", "passata"]) {
      expect(predictions.some((entry) => entry.product.slug === slug), slug).toBe(false);
    }
  });
});

describe("Plenty's loop: meals and the shopping list", () => {
  it("plans three different weeknight dinners the household can eat, using what's about to go off first", () => {
    expect(plan.map((item) => item.date)).toEqual(PLAN_DATES);
    expect(new Set(plan.map((item) => item.mealId)).size).toBe(3);
    for (const { meal } of plannedMeals) {
      expect(isMealAllowed(meal, PREFS, PRODUCTS).allowed, meal.id).toBe(true);
      expect(meal.timeMinutes, meal.id).toBeLessThanOrEqual((PREFS.weeknightMaxMinutes ?? 0) * 1.5);
      expect(meal.ingredients.some((i) => i.productId === "mushrooms" && !i.optional), meal.id).toBe(false);
    }
    // The mince expires tomorrow and the chicken the day after: both get cooked in time.
    const usesOnOrBefore = (slug: string, date: string) =>
      plannedMeals.some(({ item, meal }) => item.date <= date && meal.ingredients.some((i) => i.productId === slug));
    expect(usesOnOrBefore("beef-mince", "2026-09-29")).toBe(true);
    expect(usesOnOrBefore("chicken-breast", "2026-09-30")).toBe(true);
    expect(plan[0].reason).toMatch(/go off soon/);
  });

  it("works out what the plan needs net of the kitchen, without double-counting stock across meals", () => {
    expect(requirements.meals).toHaveLength(3);
    const missingIds = new Set(requirements.missing.map((m) => m.productId));
    // Fresh from the receipt or already in the cupboard, in more than enough quantity.
    for (const slug of ["beef-mince", "chicken-breast", "spaghetti", "olive-oil", "garlic", "brown-onion", "jasmine-rice", "basmati-rice"]) {
      expect(missingIds.has(slug), slug).toBe(false);
    }
    const planned = requirements.meals.flatMap((m) => m.ingredients);
    for (const missing of requirements.missing) {
      expect(missing.forPlanItemIds.length, missing.name).toBeGreaterThan(0);
      expect(missing.reason, missing.name).toMatch(/^For (tonight|tomorrow|\w+day)'s /);
      // The shortfall is exactly what the meals needed beyond what the kitchen covered…
      const p = product(missing.productId ?? "");
      const unit = missing.unit ?? p.unit;
      const short = planned
        .filter((i) => i.productId === p.id && (i.status === "missing" || i.status === "partial"))
        .reduce((sum, i) => sum + (convertForProduct((i.neededQuantity ?? 0) - (i.coveredQuantity ?? 0), i.unit ?? unit, unit, p) ?? Number.NaN), 0);
      expect(missing.shortfallQuantity, missing.name).toBeCloseTo(short, 3);
      // …and what to buy is that, rounded up to whole packs (or pieces of loose produce).
      expect(missing.purchaseQuantity, missing.name).toBeGreaterThanOrEqual(short);
      expect(missing.purchaseQuantity, missing.name).toBeLessThan(short + (p.aisle === "produce" && p.unit === "each" ? 1 : p.packageQuantity));
    }

    // Stock is claimed once: across all three meals, no product (or substitute family) is used beyond what's there.
    const familyOf = (p: ProductInfo) => p.group ?? p.id;
    const usedByFamily = new Map<string, number>();
    for (const i of planned) {
      const p = i.productId ? PRODUCTS.get(i.productId) : undefined;
      if (!p || !i.unit || !i.coveredQuantity) continue;
      const base = toBaseUnit(i.coveredQuantity, i.unit, baseUnitOf(p), p);
      if (base !== null) usedByFamily.set(familyOf(p), (usedByFamily.get(familyOf(p)) ?? 0) + base);
    }
    expect(usedByFamily.get("beef-mince")).toBeGreaterThan(0);
    for (const [family, used] of usedByFamily) {
      const stock = kitchen
        .filter((lot) => lot.productId && familyOf(product(lot.productId)) === family)
        .reduce((sum, lot) => sum + (lotRemaining(lot, baseUnitOf(product(lot.productId ?? "")), product(lot.productId ?? "")) ?? 0), 0);
      expect(used, family).toBeLessThanOrEqual(stock + 1e-6);
    }
    // Each planned ingredient that isn't in the kitchen at all (and isn't a basic) is on the missing list.
    const inKitchen = new Set(kitchen.map((lot) => lot.productId));
    for (const { item, meal } of plannedMeals) {
      for (const ingredient of meal.ingredients) {
        const p = ingredient.productId ? PRODUCTS.get(ingredient.productId) : undefined;
        if (!p || ingredient.optional || p.pantryBasic || inKitchen.has(p.id) || (p.group && kitchen.some((lot) => PRODUCTS.get(lot.productId ?? "")?.group === p.group))) continue;
        const line = requirements.missing.find((m) => m.productId === p.id);
        expect(line, `${meal.id}: ${p.slug}`).toBeDefined();
        expect(line?.forPlanItemIds, `${meal.id}: ${p.slug}`).toContain(`plan-${item.date}`);
      }
    }
  });

  it("learns the weekly Sunday shop and plans purchases up to the shop after next", () => {
    expect(rhythm).toMatchObject({ typicalWeekday: 0, intervalDays: 7, basis: "history", confidence: "high" });
    expect(rhythm.nextShopDate).toBe("2026-10-04");
    expect(weekdayOf(rhythm.nextShopDate)).toBe(0);
    expect(rhythm.followingShopDate).toBe("2026-10-11");
    expect(horizonDays).toBe(13);
  });

  it("builds the list: meal shortfalls and predicted run-outs in, well-stocked items out", () => {
    const keys = new Set(needs.map((need) => need.itemKey));
    expect(keys.size).toBe(needs.length);

    // Milk runs out in ~4 days: buy enough to reach the shop after next, in whole 2 L bottles.
    const milk = needFor(MILK.slug);
    expect(milk).toBeDefined();
    expect(milk?.primarySource).toBe("predicted");
    expect(milk?.unit).toBe("l");
    const rate = learnedStats(MILK.slug).dailyRate ?? 0;
    const wantedLitres = (rate * (horizonDays - predictionFor(MILK.slug).daysRemaining)) / 1000;
    expect(milk?.quantity).toBe(Math.ceil(wantedLitres / 2) * 2);
    expect(milk?.reason).toBe("Likely to run out in about 4 days");

    // Bread keeps six days: two fresh loaves and a note, not the four the fortnight would need.
    expect(needFor(BREAD.slug)).toMatchObject({ quantity: 2, unit: "loaf", primarySource: "predicted", advice: FRESHNESS_ADVICE });

    // Every missing meal ingredient is on the list, for its meals.
    for (const missing of requirements.missing) {
      const need = needs.find((n) => n.itemKey === shoppingItemKey({ productId: missing.productId, name: missing.name }));
      expect(need, missing.name).toBeDefined();
      const planIds = need?.sources.filter((s) => s.source === "meal_plan").map((s) => s.mealPlanItemId);
      expect(planIds, missing.name).toEqual(expect.arrayContaining(missing.forPlanItemIds));
    }

    // Owned in plenty and not running out before the shop after next: not on the list.
    for (const slug of ["beef-mince", "chicken-breast", "spaghetti", "passata", "olive-oil", "jasmine-rice", "garlic", "parmesan"]) {
      expect(needFor(slug), slug).toBeUndefined();
    }
    // Everything predicted to last past the horizon stays off; everything running out before it is on.
    for (const input of predictionInputs) {
      const listed = needs.some((need) => need.itemKey === input.itemKey && need.sources.some((s) => s.source === "predicted"));
      expect(listed, input.name).toBe(input.daysRemaining <= horizonDays);
    }
  });

  it("reconciles with the existing list without duplicating or undoing the household's own items", () => {
    const createdKeys = reconciled.create.map((need) => need.itemKey);
    const existingKeys = new Set(existingList.map((row) => row.itemKey));
    expect(createdKeys.filter((key) => existingKeys.has(key))).toEqual([]);

    // Milk was already on the list: refreshed in place with the new amount and reason.
    const milkUpdate = reconciled.update.find((u) => u.id === "row-milk");
    expect(milkUpdate).toMatchObject({ source: "predicted", suggestedQuantity: needFor(MILK.slug)?.quantity, suggestedUnit: "l" });
    expect(milkUpdate?.reason).toBe("Likely to run out in about 4 days");

    // Plenty's stale spaghetti row goes; the household's edited passata, manual items,
    // the checked bananas and the dismissed yoghurt all stay, untouched.
    expect(reconciled.remove).toEqual(["row-spaghetti"]);
    const touched = new Set(reconciled.update.map((u) => u.id));
    for (const id of ["row-bananas", "row-yoghurt", "row-passata", "row-dish-liquid", "row-birthday-candles"]) expect(touched.has(id), id).toBe(false);
    // Bananas and yoghurt are needed, but the checked and dismissed rows stand for them.
    expect(needFor("banana")).toBeDefined();
    expect(needFor("natural-yoghurt")).toBeDefined();
    expect(createdKeys).not.toContain(shoppingItemKey({ productId: "banana", name: "Banana" }));
    expect(createdKeys).not.toContain(shoppingItemKey({ productId: "natural-yoghurt", name: "Natural yoghurt" }));

    // Missing meal ingredients and new run-outs are created; nothing the kitchen covers is.
    for (const missing of requirements.missing) {
      const key = shoppingItemKey({ productId: missing.productId, name: missing.name });
      expect(createdKeys.includes(key) || reconciled.update.some((u) => existingList.find((row) => row.id === u.id)?.itemKey === key), missing.name).toBe(true);
    }
    expect(createdKeys).toContain(shoppingItemKey({ productId: "eggs", name: "Eggs" }));
    for (const slug of ["beef-mince", "chicken-breast", "spaghetti", "passata"]) {
      expect(createdKeys, slug).not.toContain(shoppingItemKey({ productId: slug, name: product(slug).name }));
    }

    // Reconciling the same needs against the reconciled list creates and removes nothing.
    const afterwards: ExistingListItem[] = [
      ...existingList.filter((row) => !reconciled.remove.includes(row.id)),
      ...reconciled.create.map((need, i) => listItem(`new-${i}`, need.productId ?? need.name, { itemKey: need.itemKey, source: need.primarySource, suggestedQuantity: need.quantity, suggestedUnit: need.unit })),
    ];
    const again = reconcileShoppingList(afterwards, needs, NOW);
    expect(again.create).toEqual([]);
    expect(again.remove).toEqual([]);
  });
});
