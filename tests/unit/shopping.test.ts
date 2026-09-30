import { describe, expect, it } from "vitest";
import { CATALOG, productInfoFromCatalog, type ProductInfo } from "@/lib/catalog";
import { addDaysToInstant } from "@/lib/dates";
import { computePlanRequirements } from "@/lib/meals/requirements";
import type {
  ExistingListItem,
  InventoryLot,
  MissingIngredient,
  PlannableMeal,
  PredictionInput,
  ShoppingNeed,
  StapleInput,
} from "@/lib/meals/types";
import {
  FRESHNESS_ADVICE,
  WASTE_ADVICE_SMALLER,
  WASTE_ADVICE_SMALLEST,
  computeShoppingNeeds,
  reconcileShoppingList,
  runOutReason,
  shoppingItemKey,
  stapleReason,
  type ShoppingNeedsInput,
  type WasteStats,
} from "@/lib/shopping";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRODUCTS: ReadonlyMap<string, ProductInfo> = new Map(CATALOG.map((p) => [p.slug, productInfoFromCatalog(p)]));

function product(slug: string): ProductInfo {
  const found = PRODUCTS.get(slug);
  if (!found) throw new Error(`No catalog product ${slug}`);
  return found;
}

/** Saturday morning, shopping day. */
const NOW = new Date("2026-10-03T09:00:00Z");
const WEEKLY_HORIZON = 7;

function prediction(slug: string, daysRemaining: number, dailyRate: number, overrides: Partial<PredictionInput> = {}): PredictionInput {
  const p = product(slug);
  const baseUnit = p.unit === "l" || p.unit === "ml" ? "ml" : p.unit === "g" || p.unit === "kg" ? "g" : "each";
  return {
    productId: slug,
    itemKey: shoppingItemKey({ productId: slug, name: p.name }),
    name: p.name,
    aisle: p.aisle,
    daysRemaining,
    daysLow: daysRemaining * 0.8,
    daysHigh: daysRemaining * 1.2,
    confidence: "high",
    basis: "history",
    dailyRate,
    baseUnit,
    ...overrides,
  };
}

function staple(slug: string, overrides: Partial<StapleInput> = {}): StapleInput {
  const p = product(slug);
  return {
    productId: slug,
    name: p.name,
    aisle: p.aisle,
    typicalPurchaseAmount: null,
    baseUnit: "each",
    lastPurchasedAt: null,
    typicalIntervalDays: null,
    hasActiveStock: false,
    ...overrides,
  };
}

function needsFor(overrides: Partial<ShoppingNeedsInput>): ShoppingNeed[] {
  return computeShoppingNeeds({
    predictions: [],
    planMissing: [],
    staples: [],
    products: PRODUCTS,
    waste: new Map(),
    horizonDays: WEEKLY_HORIZON,
    now: NOW,
    ...overrides,
  });
}

function need(needs: ShoppingNeed[], itemKey: string): ShoppingNeed {
  const found = needs.find((n) => n.itemKey === itemKey);
  if (!found) throw new Error(`No need ${itemKey}; have ${needs.map((n) => n.itemKey).join(", ")}`);
  return found;
}

function daysAgo(days: number): Date {
  return addDaysToInstant(NOW, -days);
}

// ─── Keys ───────────────────────────────────────────────────────────────────

describe("shoppingItemKey", () => {
  it("keys products by id and free text by normalised singular name", () => {
    expect(shoppingItemKey({ productId: "8f2c", name: "Full cream milk" })).toBe("p:8f2c");
    expect(shoppingItemKey({ productId: null, name: "Cherry Tomatoes" })).toBe("n:cherry tomato");
    expect(shoppingItemKey({ productId: null, name: "  cherry tomato " })).toBe("n:cherry tomato");
    expect(shoppingItemKey({ productId: null, name: "Jalapeños" })).toBe("n:jalapeno");
  });
});

// ─── Wording ────────────────────────────────────────────────────────────────

describe("reasons", () => {
  it("describes run-outs without false precision", () => {
    expect(runOutReason({ daysRemaining: 2.2, daysLow: 1.8, daysHigh: 2.6, confidence: "high" })).toBe("Likely to run out in about 2 days");
    expect(runOutReason({ daysRemaining: 0.5, daysLow: 0.3, daysHigh: 0.8, confidence: "high" })).toBe("Likely to run out today");
    expect(runOutReason({ daysRemaining: 0.1, daysLow: 0, daysHigh: 0.5, confidence: "medium" })).toBe("You've probably run out");
    expect(runOutReason({ daysRemaining: 3, daysLow: 2, daysHigh: 5, confidence: "low" })).toBe("Likely to run out in 2–5 days");
    expect(runOutReason({ daysRemaining: 1.2, daysLow: 0.2, daysHigh: 3, confidence: "low" })).toBe("Likely to run out within 3 days");
  });

  it("describes a staple's rhythm", () => {
    expect(stapleReason(7)).toBe("You usually buy this every week");
    expect(stapleReason(14)).toBe("You usually buy this every 2 weeks");
    expect(stapleReason(4)).toBe("You usually buy this every 4 days");
    expect(stapleReason(30)).toBe("You usually buy this every month");
    expect(stapleReason(null)).toBe("You buy this regularly and you're out");
  });
});

// ─── Predicted needs ────────────────────────────────────────────────────────

describe("computeShoppingNeeds — predictions", () => {
  it("buys what runs out before the shop after next, enough to last until then", () => {
    const needs = needsFor({
      predictions: [
        prediction("full-cream-milk", 2, 400), // 5 days uncovered × 400 ml = 2 L
        prediction("eggs", 0.1, 1.5), // 7 days × 1.5 = 10.5 eggs → a dozen
        prediction("white-bread", 12, 0.25), // lasts past the horizon: not needed
      ],
    });
    expect(needs.map((n) => [n.itemKey, n.quantity, n.unit, n.primarySource])).toEqual([
      ["p:eggs", 12, "each", "predicted"],
      ["p:full-cream-milk", 2, "l", "predicted"],
    ]);
    expect(need(needs, "p:full-cream-milk").reason).toBe("Likely to run out in about 2 days");
    expect(need(needs, "p:eggs").reason).toBe("You've probably run out");
  });

  it("always suggests at least one package", () => {
    const [milk] = needsFor({ predictions: [prediction("full-cream-milk", 7, 400)] });
    expect(milk).toMatchObject({ quantity: 2, unit: "l" });
  });

  it("keeps free-text predictions in their base unit", () => {
    const [stock] = needsFor({
      predictions: [
        { ...prediction("chicken-stock", 1, 100), productId: null, name: "Homemade bone broth", itemKey: "n:homemade bone broth", aisle: "other" },
      ],
    });
    expect(stock).toMatchObject({ itemKey: "n:homemade bone broth", productId: null, quantity: 600, unit: "ml" });
  });
});

// ─── Staples ────────────────────────────────────────────────────────────────

describe("computeShoppingNeeds — staples", () => {
  it("adds staples that are out and due, with one typical purchase", () => {
    const needs = needsFor({
      staples: [
        staple("toilet-paper", { typicalPurchaseAmount: 24, lastPurchasedAt: daysAgo(18), typicalIntervalDays: 21 }),
        staple("dishwasher-tablets", { typicalPurchaseAmount: 1, lastPurchasedAt: daysAgo(3), typicalIntervalDays: 14 }),
        staple("banana", { typicalPurchaseAmount: 7, lastPurchasedAt: daysAgo(8), typicalIntervalDays: 7, hasActiveStock: true }),
        staple("instant-coffee", { baseUnit: "g" }),
      ],
    });
    expect(needs.map((n) => [n.itemKey, n.quantity, n.unit, n.reason])).toEqual([
      ["p:instant-coffee", product("instant-coffee").packageQuantity, product("instant-coffee").unit, "You buy this regularly and you're out"],
      ["p:toilet-paper", 24, "each", "You usually buy this every 3 weeks"],
    ]);
    expect(needs.every((n) => n.primarySource === "staple")).toBe(true);
  });

  it("leaves staples to the prediction when one exists", () => {
    const needs = needsFor({
      predictions: [prediction("eggs", 1, 1)],
      staples: [staple("eggs", { typicalPurchaseAmount: 12, typicalIntervalDays: 10, lastPurchasedAt: daysAgo(12) })],
    });
    expect(needs).toHaveLength(1);
    expect(needs[0].sources.map((s) => s.source)).toEqual(["predicted"]);
  });

  it("does not add a staple the household has enough of according to its prediction", () => {
    const needs = needsFor({
      predictions: [prediction("white-bread", 20, 0.1)],
      staples: [staple("white-bread", { typicalPurchaseAmount: 1, typicalIntervalDays: 5, lastPurchasedAt: daysAgo(6) })],
    });
    expect(needs).toEqual([]);
  });
});

// ─── Meal plan ──────────────────────────────────────────────────────────────

const RICE_PUDDING: PlannableMeal = {
  id: "rice-pudding",
  slug: "rice-pudding",
  name: "Baked rice pudding",
  cuisine: "british",
  timeMinutes: 90,
  difficulty: "easy",
  servings: 6,
  mainIngredient: "rice",
  tags: [],
  contains: ["dairy"],
  ingredients: [
    { name: "full cream milk", productId: "full-cream-milk", quantity: 1500, unit: "ml", optional: false },
    { name: "arborio rice", productId: "arborio-rice", quantity: 150, unit: "g", optional: false },
    { name: "nutmeg", productId: null, quantity: null, unit: null, optional: false },
  ],
  source: "library",
};

const KITCHEN: InventoryLot[] = [
  { id: "milk", productId: "full-cream-milk", name: "Full cream milk", quantity: 2, unit: "l", remainingFraction: 0.4, expiresOn: "2026-10-08", location: "fridge" },
  { id: "rice", productId: "arborio-rice", name: "Arborio rice", quantity: 1000, unit: "g", remainingFraction: 0.5, expiresOn: null, location: "pantry" },
];

describe("computeShoppingNeeds — meal plan", () => {
  const requirements = computePlanRequirements({
    items: [{ planItemId: "sun-dinner", date: "2026-10-04", servings: 6, meal: RICE_PUDDING }],
    lots: KITCHEN,
    products: PRODUCTS,
  });

  it("turns plan shortfalls into needs that remember their plan items", () => {
    const needs = needsFor({ planMissing: requirements.missing });
    expect(needs.map((n) => [n.itemKey, n.quantity, n.unit])).toEqual([
      ["p:full-cream-milk", 2, "l"],
      ["n:nutmeg", 1, "each"],
    ]);
    expect(need(needs, "p:full-cream-milk")).toMatchObject({
      primarySource: "meal_plan",
      reason: "For Sunday's baked rice pudding",
      sources: [{ source: "meal_plan", quantity: 2, unit: "l", note: "For Sunday's baked rice pudding", mealPlanItemId: "sun-dinner" }],
    });
  });

  it("merges a meal-plan shortfall with a predicted run-out of the same product", () => {
    // 0.7 L short for the pudding + 2 L to last the week = 2.7 L → two 2 L bottles, not three.
    const needs = needsFor({ planMissing: requirements.missing, predictions: [prediction("full-cream-milk", 2, 400)] });
    const milk = need(needs, "p:full-cream-milk");
    expect(milk).toMatchObject({ quantity: 4, unit: "l", primarySource: "meal_plan" });
    expect(milk.reason).toBe("For Sunday's baked rice pudding · Likely to run out in about 2 days");
    expect(milk.sources.map((s) => [s.source, s.quantity])).toEqual([
      ["meal_plan", 2],
      ["predicted", 2],
    ]);
    expect(needs.filter((n) => n.itemKey === "p:full-cream-milk")).toHaveLength(1);
  });

  it("keeps one source per plan item when a line serves several meals", () => {
    const shared: MissingIngredient = {
      key: "brown-onion",
      productId: "brown-onion",
      name: "Brown onion",
      aisle: "produce",
      shortfallQuantity: 2,
      unit: "each",
      purchaseQuantity: 2,
      purchaseUnit: "each",
      forPlanItemIds: ["mon", "wed"],
      reason: "For Monday's chicken curry and Wednesday's beef tacos",
    };
    const [onions] = needsFor({ planMissing: [shared] });
    expect(onions.quantity).toBe(2);
    expect(onions.sources.map((s) => [s.mealPlanItemId, s.quantity])).toEqual([
      ["mon", 2],
      ["wed", null],
    ]);
  });
});

// ─── Freshness ──────────────────────────────────────────────────────────────

describe("computeShoppingNeeds — freshness", () => {
  it("buys perishables for no longer than they keep, and says why", () => {
    // Bread keeps 6 days: 0.3 loaves a day for 11 days would be 4 loaves, two of them stale.
    const [bread] = needsFor({ predictions: [prediction("white-bread", 2, 0.3)], horizonDays: 13 });
    expect(bread).toMatchObject({ quantity: 2, unit: "loaf", advice: FRESHNESS_ADVICE });
    // Bananas keep 5 days: 6.5 bananas' worth, not 12.
    const [bananas] = needsFor({ predictions: [prediction("banana", 4, 1.3)], horizonDays: 13 });
    expect(bananas).toMatchObject({ quantity: 7, unit: "each", advice: FRESHNESS_ADVICE });
  });

  it("leaves long-life products and short horizons alone", () => {
    // Rice isn't perishable: the full horizon's worth, no advice.
    const [rice] = needsFor({ predictions: [prediction("white-rice", 2, 60)], horizonDays: 13 });
    expect(rice.quantity).toBe(1000);
    expect(rice.advice).toBeUndefined();
    // Milk keeps 10 days; 5 days' cover is within that.
    const [milk] = needsFor({ predictions: [prediction("full-cream-milk", 2, 700)], horizonDays: 7 });
    expect(milk.quantity).toBe(4);
    expect(milk.advice).toBeUndefined();
  });

  it("never limits what a planned meal needs", () => {
    const planned: MissingIngredient = {
      key: "white-bread",
      productId: "white-bread",
      name: "White bread",
      aisle: "bakery",
      shortfallQuantity: 3,
      unit: "loaf",
      purchaseQuantity: 3,
      purchaseUnit: "loaf",
      forPlanItemIds: ["sat"],
      reason: "For Saturday's sandwiches",
    };
    const [bread] = needsFor({ planMissing: [planned], predictions: [prediction("white-bread", 2, 0.3)], horizonDays: 13 });
    // 3 loaves for the meal plus 2 fresh loaves' worth of everyday use.
    expect(bread.quantity).toBe(5);
    expect(bread.primarySource).toBe("meal_plan");
  });
});

// ─── Waste ──────────────────────────────────────────────────────────────────

describe("computeShoppingNeeds — waste advice", () => {
  const waste = new Map<string, WasteStats>([
    ["baby-spinach", { wasteRatio: 0.5, wasteEvents: 3 }],
    ["greek-yoghurt", { wasteRatio: 0.3, wasteEvents: 2 }],
    ["banana", { wasteRatio: 0.4, wasteEvents: 4 }],
    ["lite-milk", { wasteRatio: 0.6, wasteEvents: 1 }],
  ]);

  it("suggests a smaller amount of things the household often throws out", () => {
    // 5 days (all it keeps) × 50 g = 250 g → three bags usually; halved for waste → two bags.
    const [spinach] = needsFor({ predictions: [prediction("baby-spinach", 1, 50)], waste, horizonDays: 6 });
    expect(spinach).toMatchObject({ quantity: 240, unit: "g", advice: WASTE_ADVICE_SMALLER });
  });

  it("says the smallest pack will do when it can't go smaller", () => {
    const [yoghurt] = needsFor({ predictions: [prediction("greek-yoghurt", 3, 50)], waste });
    expect(yoghurt).toMatchObject({ quantity: 1000, advice: WASTE_ADVICE_SMALLEST });
  });

  it("can go below a pack for loose produce", () => {
    // 6 days × 0.5 = 3 bananas; 40% wasted → 1.8 → 2 loose bananas.
    const [bananas] = needsFor({ predictions: [prediction("banana", 1, 0.5)], waste });
    expect(bananas).toMatchObject({ quantity: 2, unit: "each", advice: WASTE_ADVICE_SMALLER });
  });

  it("needs a pattern, not a one-off", () => {
    const [milk] = needsFor({ predictions: [prediction("lite-milk", 1, 600)], waste });
    expect(milk.advice).toBeUndefined();
    expect(milk.quantity).toBe(4);
  });

  it("never trims what a planned meal needs", () => {
    const planned: MissingIngredient = {
      key: "baby-spinach",
      productId: "baby-spinach",
      name: "Baby spinach",
      aisle: "produce",
      shortfallQuantity: 200,
      unit: "g",
      purchaseQuantity: 240,
      purchaseUnit: "g",
      forPlanItemIds: ["tue"],
      reason: "For Tuesday's spinach and ricotta lasagne",
    };
    const [spinach] = needsFor({ planMissing: [planned], waste });
    expect(spinach).toMatchObject({ quantity: 240, primarySource: "meal_plan" });
    expect(spinach.advice).toBeUndefined();
  });
});

// ─── Ordering ───────────────────────────────────────────────────────────────

describe("computeShoppingNeeds — ordering", () => {
  it("returns one need per item in supermarket aisle order", () => {
    const needs = needsFor({
      predictions: [prediction("full-cream-milk", 1, 400), prediction("banana", 1, 1), prediction("white-bread", 1, 0.25)],
      staples: [staple("toilet-paper", { typicalPurchaseAmount: 12 })],
    });
    expect(needs.map((n) => n.aisle)).toEqual(["produce", "bakery", "dairy", "household"]);
  });
});

// ─── Reconciliation ─────────────────────────────────────────────────────────

function existing(id: string, itemKey: string, overrides: Partial<ExistingListItem> = {}): ExistingListItem {
  return {
    id,
    itemKey,
    productId: itemKey.startsWith("p:") ? itemKey.slice(2) : null,
    name: id,
    aisle: "other",
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

function shoppingNeed(itemKey: string, overrides: Partial<ShoppingNeed> = {}): ShoppingNeed {
  return {
    itemKey,
    productId: itemKey.startsWith("p:") ? itemKey.slice(2) : null,
    name: itemKey,
    aisle: "other",
    quantity: 1,
    unit: "each",
    sources: [{ source: "predicted", quantity: 1, unit: "each", note: "Likely to run out in about 2 days" }],
    primarySource: "predicted",
    reason: "Likely to run out in about 2 days",
    ...overrides,
  };
}

describe("reconcileShoppingList", () => {
  const list: ExistingListItem[] = [
    existing("milk-manual", "p:full-cream-milk", { source: "manual", quantity: 1, unit: "l", userEdited: true }),
    existing("eggs-auto", "p:eggs", { suggestedQuantity: 12, suggestedUnit: "each" }),
    existing("bread-stale", "p:white-bread", { source: "staple", suggestedQuantity: 1, suggestedUnit: "loaf" }),
    existing("cheese-edited", "p:cheddar-cheese", { quantity: 1, unit: "each", userEdited: true }),
    existing("spinach-dismissed", "p:baby-spinach", { dismissedUntil: addDaysToInstant(NOW, 3) }),
    existing("rocket-was-dismissed", "p:rocket", { dismissedUntil: addDaysToInstant(NOW, -1) }),
    existing("yoghurt-lapsed", "p:greek-yoghurt", { dismissedUntil: addDaysToInstant(NOW, -1) }),
    existing("bananas-checked", "p:banana", { checkedAt: addDaysToInstant(NOW, -0.1) }),
    existing("tuna-checked", "p:canned-tuna", { source: "meal_plan", checkedAt: addDaysToInstant(NOW, -0.1) }),
    existing("cordial-bought", "p:cordial", { purchasedAt: addDaysToInstant(NOW, -0.2) }),
    existing("candles-manual", "n:birthday candle", { source: "manual" }),
  ];
  const needs: ShoppingNeed[] = [
    shoppingNeed("p:full-cream-milk", {
      quantity: 4,
      unit: "l",
      primarySource: "meal_plan",
      reason: "For Sunday's baked rice pudding · Likely to run out in about 2 days",
      sources: [
        { source: "meal_plan", quantity: 2, unit: "l", note: "For Sunday's baked rice pudding", mealPlanItemId: "sun" },
        { source: "predicted", quantity: 2, unit: "l", note: "Likely to run out in about 2 days" },
      ],
    }),
    shoppingNeed("p:eggs", { quantity: 24, advice: "You often throw some of this out — this is a smaller amount than usual." }),
    shoppingNeed("p:baby-spinach", { quantity: 120, unit: "g" }),
    shoppingNeed("p:rocket", { quantity: 120, unit: "g" }),
    shoppingNeed("p:banana", { quantity: 6 }),
    shoppingNeed("p:toilet-paper", { quantity: 24, primarySource: "staple", reason: "You usually buy this every 3 weeks" }),
    shoppingNeed("p:toilet-paper", { quantity: 48 }),
  ];
  const result = reconcileShoppingList(list, needs, NOW);

  it("adds needs that aren't on the list yet, once", () => {
    expect(result.create.map((n) => [n.itemKey, n.quantity])).toEqual([["p:toilet-paper", 24]]);
  });

  it("never changes a manual item's quantity, but adds Plenty's reasons to it", () => {
    const milk = result.update.find((u) => u.id === "milk-manual");
    expect(milk).toEqual({
      id: "milk-manual",
      suggestedQuantity: null,
      suggestedUnit: null,
      source: "manual",
      reason: "For Sunday's baked rice pudding · Likely to run out in about 2 days",
      advice: null,
      sources: needs[0].sources,
    });
    expect(result.remove).not.toContain("candles-manual");
  });

  it("refreshes Plenty's own items with the new suggestion", () => {
    expect(result.update.find((u) => u.id === "eggs-auto")).toMatchObject({
      suggestedQuantity: 24,
      suggestedUnit: "each",
      source: "predicted",
      advice: "You often throw some of this out — this is a smaller amount than usual.",
    });
    // A lapsed dismissal no longer blocks the need.
    expect(result.update.find((u) => u.id === "rocket-was-dismissed")).toMatchObject({ suggestedQuantity: 120, suggestedUnit: "g" });
  });

  it("respects dismissals and leaves checked or purchased items alone", () => {
    const touched = new Set([...result.update.map((u) => u.id), ...result.remove]);
    for (const id of ["spinach-dismissed", "bananas-checked", "tuna-checked", "cordial-bought"]) expect(touched.has(id)).toBe(false);
    expect(result.create.map((n) => n.itemKey)).not.toContain("p:baby-spinach");
    expect(result.create.map((n) => n.itemKey)).not.toContain("p:banana");
  });

  it("removes auto items that are no longer needed, unless the user made them theirs", () => {
    expect(result.remove).toEqual(["bread-stale", "yoghurt-lapsed"]);
  });

  it("does nothing when the list already matches and nothing is needed", () => {
    expect(reconcileShoppingList([], [], NOW)).toEqual({ create: [], update: [], remove: [] });
    expect(reconcileShoppingList([existing("manual", "n:bin bag", { source: "manual" })], [], NOW)).toEqual({ create: [], update: [], remove: [] });
  });
});
