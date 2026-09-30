import { describe, expect, it } from "vitest";
import { CATALOG, productInfoFromCatalog, type ProductInfo } from "@/lib/catalog";
import { computePlanRequirements, purchaseIncrement, roundUpToPurchase } from "@/lib/meals/requirements";
import type { InventoryLot, MealIngredientInput, MissingIngredient, PlanMealInput, PlannableMeal } from "@/lib/meals/types";
import type { Unit } from "@/lib/units";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRODUCTS: ReadonlyMap<string, ProductInfo> = new Map(CATALOG.map((p) => [p.slug, productInfoFromCatalog(p)]));

function product(slug: string): ProductInfo {
  const found = PRODUCTS.get(slug);
  if (!found) throw new Error(`No catalog product ${slug}`);
  return found;
}

function lot(id: string, productId: string, overrides: Partial<InventoryLot> = {}): InventoryLot {
  const p = product(productId);
  return {
    id,
    productId,
    name: p.name,
    quantity: p.packageQuantity,
    unit: p.unit,
    remainingFraction: 1,
    expiresOn: null,
    location: p.location,
    ...overrides,
  };
}

function ing(name: string, productId: string | null, quantity: number | null = null, unit: Unit | null = null, optional = false): MealIngredientInput {
  return { name, productId, quantity, unit, optional };
}

function meal(name: string, servings: number, ingredients: MealIngredientInput[]): PlannableMeal {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  return {
    id: slug,
    slug,
    name,
    cuisine: "other",
    timeMinutes: 30,
    difficulty: "easy",
    servings,
    mainIngredient: ingredients[0]?.name ?? "",
    tags: [],
    contains: [],
    ingredients,
    source: "library",
  };
}

function plan(planItemId: string, date: string, dish: PlannableMeal, servings = dish.servings): PlanMealInput {
  return { planItemId, date, servings, meal: dish };
}

function line(missing: MissingIngredient[], key: string): MissingIngredient {
  const found = missing.find((m) => m.key === key);
  if (!found) throw new Error(`No shopping line for ${key}; have ${missing.map((m) => m.key).join(", ")}`);
  return found;
}

// Monday 5 – Wednesday 7 October 2026.
const MON = "2026-10-05";
const TUE = "2026-10-06";
const WED = "2026-10-07";

const CHICKEN_CURRY = meal("Chicken curry", 4, [
  ing("vegetable oil", "vegetable-oil", 2, "tbsp"),
  ing("brown onions", "brown-onion", 2, "each"),
  ing("garlic", "garlic", 15, "g"),
  ing("ginger", "ginger", 20, "g"),
  ing("ground cumin", "ground-cumin", 2, "tsp"),
  ing("ground coriander", "ground-coriander", 2, "tsp"),
  ing("ground turmeric", "ground-turmeric", 1, "tsp"),
  ing("garam masala", "garam-masala", 2, "tsp"),
  ing("chilli powder", "chilli-powder", 0.5, "tsp"),
  ing("diced tomatoes", "diced-tomatoes", 1, "can"),
  ing("chicken thigh fillets", "chicken-thigh", 800, "g"),
  ing("natural yoghurt", "natural-yoghurt", 200, "g"),
  ing("water", "water"),
  ing("basmati rice", "basmati-rice", 300, "g"),
  ing("coriander", "coriander", 0.5, "bunch"),
  ing("long green chilli", "chilli", 1, "each", true),
  ing("salt", "salt"),
]);

const TOMATO_PASTA = meal("Pasta with tomato sauce", 4, [
  ing("penne", "penne", 400, "g"),
  ing("extra virgin olive oil", "extra-virgin-olive-oil", 3, "tbsp"),
  ing("garlic", "garlic", 10, "g"),
  ing("whole peeled tomatoes", "whole-peeled-tomatoes", 2, "can"),
  ing("sugar", "white-sugar", 1, "pinch"),
  ing("butter", "butter", 20, "g"),
  ing("basil", "basil", 0.5, "bunch"),
  ing("parmesan", "parmesan", 40, "g"),
  ing("salt", "salt"),
  ing("black pepper", "black-pepper"),
]);

const BEEF_TACOS = meal("Beef tacos", 4, [
  ing("olive oil", "olive-oil", 1, "tbsp"),
  ing("brown onion", "brown-onion", 1, "each"),
  ing("garlic", "garlic", 10, "g"),
  ing("beef mince", "beef-mince", 500, "g"),
  ing("ground cumin", "ground-cumin", 2, "tsp"),
  ing("smoked paprika", "smoked-paprika", 2, "tsp"),
  ing("dried oregano", "dried-oregano", 1, "tsp"),
  ing("chilli powder", "chilli-powder", 0.5, "tsp", true),
  ing("tomato paste", "tomato-paste", 2, "tbsp"),
  ing("water", "water"),
  ing("taco shells", "taco-shells", 12, "each"),
  ing("iceberg lettuce", "iceberg-lettuce", 0.25, "each"),
  ing("tomatoes", "tomato", 2, "each"),
  ing("cheddar", "cheddar-cheese", 100, "g"),
  ing("sour cream", "sour-cream", 150, "g"),
  ing("avocado", "avocado", 1, "each", true),
  ing("lime", "lime", 1, "each"),
  ing("salt", "salt"),
]);

/** A realistic kitchen the weekend before: some things plenty, some low, some about to go. */
const KITCHEN: InventoryLot[] = [
  lot("veg-oil", "vegetable-oil", { remainingFraction: 0.6 }),
  lot("evoo", "extra-virgin-olive-oil", { remainingFraction: 0.4 }),
  lot("onion", "brown-onion", { quantity: 1 }),
  lot("garlic", "garlic"),
  lot("ginger", "ginger", { remainingFraction: 0.5, expiresOn: "2026-10-20" }),
  lot("cumin", "ground-cumin", { remainingFraction: 0.5 }),
  lot("gr-coriander", "ground-coriander", { remainingFraction: 0.5 }),
  lot("turmeric", "ground-turmeric", { remainingFraction: 0.5 }),
  lot("garam", "garam-masala", { remainingFraction: 0.5 }),
  lot("chilli-powder", "chilli-powder", { remainingFraction: 0.5 }),
  lot("paprika", "smoked-paprika", { remainingFraction: 0.5 }),
  lot("oregano", "dried-oregano", { remainingFraction: 0.5 }),
  lot("diced", "diced-tomatoes"),
  lot("peeled", "whole-peeled-tomatoes"),
  lot("thigh", "chicken-thigh", { expiresOn: TUE }),
  lot("greek", "greek-yoghurt", { remainingFraction: 0.4, expiresOn: "2026-10-15" }),
  lot("rice", "white-rice", { remainingFraction: 0.5 }),
  lot("penne", "penne"),
  lot("sugar", "white-sugar", { remainingFraction: 0.5 }),
  lot("butter", "butter", { remainingFraction: 0.5, expiresOn: "2026-11-01" }),
  lot("parmesan", "parmesan", { remainingFraction: 0.125, expiresOn: "2026-11-01" }),
  lot("mince", "beef-mince", { expiresOn: TUE }),
  lot("paste", "tomato-paste", { remainingFraction: 0.5 }),
  lot("cheddar", "cheddar-cheese", { remainingFraction: 0.3, expiresOn: "2026-10-30" }),
  // Noise that must not be mistaken for anything in the plan.
  lot("lite-milk", "lite-milk", { expiresOn: "2026-10-09" }),
  lot("stock", "chicken-stock"),
  lot("loo-roll", "toilet-paper"),
  { id: "spinach", productId: null, name: "Spinach", quantity: 120, unit: "g", remainingFraction: 1, expiresOn: "2026-10-08", location: "fridge" },
];

const CANONICAL_PLAN = [plan("mon", MON, CHICKEN_CURRY), plan("tue", TUE, TOMATO_PASTA), plan("wed", WED, BEEF_TACOS)];

// ─── The canonical week ─────────────────────────────────────────────────────

describe("computePlanRequirements — Monday curry, Tuesday pasta, Wednesday tacos", () => {
  const result = computePlanRequirements({ items: CANONICAL_PLAN, lots: KITCHEN, products: PRODUCTS });

  it("lists exactly what is short, once per product, in order of first need", () => {
    expect(result.missing.map((m) => [m.key, m.purchaseQuantity, m.purchaseUnit])).toEqual([
      ["brown-onion", 2, "each"],
      ["chicken-thigh", 500, "g"],
      ["coriander", 1, "bunch"],
      ["whole-peeled-tomatoes", 1, "can"],
      ["basil", 1, "bunch"],
      ["parmesan", 200, "g"],
      ["beef-mince", 500, "g"],
      ["taco-shells", 12, "each"],
      ["iceberg-lettuce", 1, "each"],
      ["tomato", 2, "each"],
      ["sour-cream", 300, "g"],
      ["lime", 1, "each"],
    ]);
    const keys = result.missing.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("aggregates onions across meals with a reason naming both", () => {
    const onions = line(result.missing, "brown-onion");
    expect(onions).toMatchObject({
      name: "Brown onion",
      aisle: "produce",
      shortfallQuantity: 2,
      unit: "each",
      forPlanItemIds: ["mon", "wed"],
      reason: "For Monday's chicken curry and Wednesday's beef tacos",
    });
  });

  it("buys only the shortfall, rounded up to the pack", () => {
    expect(line(result.missing, "chicken-thigh")).toMatchObject({ shortfallQuantity: 300, purchaseQuantity: 500, reason: "For Monday's chicken curry" });
    expect(line(result.missing, "parmesan")).toMatchObject({ shortfallQuantity: 15, purchaseQuantity: 200, forPlanItemIds: ["tue"] });
    expect(line(result.missing, "coriander")).toMatchObject({ shortfallQuantity: 0.5, unit: "bunch", purchaseQuantity: 1 });
    expect(line(result.missing, "sour-cream")).toMatchObject({ shortfallQuantity: 150, purchaseQuantity: 300 });
  });

  it("does not use mince that will have expired before Wednesday", () => {
    expect(line(result.missing, "beef-mince")).toMatchObject({ shortfallQuantity: 500, forPlanItemIds: ["wed"], reason: "For Wednesday's beef tacos" });
    const tacos = result.meals.find((m) => m.planItemId === "wed");
    expect(tacos?.ingredients.find((i) => i.name === "beef mince")?.status).toBe("missing");
  });

  it("lets Monday's curry use the diced tomatoes, so Tuesday's pasta is one can short", () => {
    const curry = result.meals.find((m) => m.planItemId === "mon");
    expect(curry?.ingredients.find((i) => i.name === "diced tomatoes")).toMatchObject({ status: "have", matchedLotIds: ["diced"], substitute: false });
    const pasta = result.meals.find((m) => m.planItemId === "tue");
    expect(pasta?.ingredients.find((i) => i.name === "whole peeled tomatoes")).toMatchObject({ status: "partial", coveredQuantity: 1, matchedLotIds: ["peeled"] });
    expect(line(result.missing, "whole-peeled-tomatoes")).toMatchObject({ shortfallQuantity: 1, purchaseQuantity: 1 });
  });

  it("covers ingredients from the same group and flags them as substitutes", () => {
    const curry = result.meals.find((m) => m.planItemId === "mon");
    expect(curry?.ingredients.find((i) => i.name === "natural yoghurt")).toMatchObject({ status: "have", substitute: true, matchedLotIds: ["greek"] });
    expect(curry?.ingredients.find((i) => i.name === "basmati rice")).toMatchObject({ status: "have", substitute: true });
    expect(curry?.ingredients.find((i) => i.name === "chicken thigh fillets")).toMatchObject({ status: "partial", usesSoonExpiring: true });
    // Ground coriander in the pantry is not fresh coriander.
    expect(curry?.ingredients.find((i) => i.name === "coriander")?.status).toBe("missing");
  });

  it("never lists assumed basics or optional extras", () => {
    const keys = result.missing.map((m) => m.key);
    for (const skipped of ["salt", "water", "black-pepper", "chilli", "avocado", "chilli-powder"]) expect(keys).not.toContain(skipped);
    const tacos = result.meals.find((m) => m.planItemId === "wed");
    expect(tacos?.ingredients.find((i) => i.name === "avocado")?.status).toBe("optional_missing");
    expect(tacos?.ingredients.find((i) => i.name === "salt")?.status).toBe("assumed");
  });

  it("returns per-meal availability after allocation, in input order", () => {
    expect(result.meals.map((m) => [m.planItemId, m.haveCount, m.missingCount, m.allAvailable])).toEqual([
      ["mon", 11, 3, false],
      ["tue", 5, 3, false],
      ["wed", 8, 7, false],
    ]);
  });
});

// ─── Allocation ─────────────────────────────────────────────────────────────

describe("computePlanRequirements — allocation across meals", () => {
  const BOLOGNESE = meal("Spaghetti bolognese", 4, [ing("beef mince", "beef-mince", 500, "g"), ing("spaghetti", "spaghetti", 400, "g")]);
  const TACOS = meal("Beef tacos", 4, [ing("beef mince", "beef-mince", 500, "g")]);
  const lots = [lot("mince", "beef-mince", { expiresOn: "2026-10-12" }), lot("spaghetti", "spaghetti")];

  it("doesn't let two meals claim the same 500 g of mince", () => {
    const result = computePlanRequirements({ items: [plan("mon", MON, BOLOGNESE), plan("wed", WED, TACOS)], lots, products: PRODUCTS });
    expect(result.missing).toEqual([
      expect.objectContaining({ key: "beef-mince", shortfallQuantity: 500, purchaseQuantity: 500, forPlanItemIds: ["wed"], reason: "For Wednesday's beef tacos" }),
    ]);
    expect(result.meals.map((m) => m.allAvailable)).toEqual([true, false]);
  });

  it("allocates by date, not by input order", () => {
    const result = computePlanRequirements({ items: [plan("wed", WED, TACOS), plan("mon", MON, BOLOGNESE)], lots, products: PRODUCTS });
    expect(result.meals.map((m) => [m.planItemId, m.allAvailable])).toEqual([
      ["wed", false],
      ["mon", true],
    ]);
    expect(result.missing[0].forPlanItemIds).toEqual(["wed"]);
  });

  it("shares a lot between meals when there is enough for both", () => {
    const result = computePlanRequirements({
      items: [plan("mon", MON, BOLOGNESE), plan("wed", WED, TACOS)],
      lots: [lot("mince", "beef-mince", { quantity: 2, unit: "pack" }), lot("spaghetti", "spaghetti")],
      products: PRODUCTS,
    });
    expect(result.missing).toEqual([]);
    expect(result.meals.every((m) => m.allAvailable)).toBe(true);
  });

  it("scales to servings and sums partial shortfalls before rounding", () => {
    const creamy = meal("Creamy mushroom gnocchi", 4, [ing("thickened cream", "thickened-cream", 150, "ml")]);
    const result = computePlanRequirements({
      items: [plan("mon", MON, creamy, 6), plan("tue", TUE, creamy, 2)],
      lots: [lot("cream", "thickened-cream", { remainingFraction: 0.5 })],
      products: PRODUCTS,
    });
    // 225 ml + 75 ml needed, 150 ml at home → 150 ml short → one 300 ml carton.
    expect(result.missing).toEqual([expect.objectContaining({ key: "thickened-cream", shortfallQuantity: 150, unit: "ml", purchaseQuantity: 300 })]);
  });
});

// ─── Package rounding ───────────────────────────────────────────────────────

describe("purchase rounding", () => {
  it("rounds up to whole packages in the product's unit", () => {
    expect(roundUpToPurchase(150, product("thickened-cream"))).toBe(300);
    expect(roundUpToPurchase(3, product("eggs"))).toBe(12);
    expect(roundUpToPurchase(13, product("eggs"))).toBe(24);
    expect(roundUpToPurchase(0, product("penne"))).toBe(500);
    expect(roundUpToPurchase(1.0000001, product("diced-tomatoes"))).toBe(1);
  });

  it("buys loose produce by the piece", () => {
    expect(purchaseIncrement(product("brown-onion"))).toBe(1);
    expect(roundUpToPurchase(2, product("brown-onion"))).toBe(2);
    expect(roundUpToPurchase(0.25, product("iceberg-lettuce"))).toBe(1);
    // Bagged produce still comes in bags.
    expect(roundUpToPurchase(60, product("baby-spinach"))).toBe(120);
  });

  it("rounds eggs for a meal to a dozen", () => {
    const dish = meal("Frittata", 4, [ing("eggs", "eggs", 8, "each")]);
    const result = computePlanRequirements({ items: [plan("mon", MON, dish)], lots: [lot("eggs", "eggs", { remainingFraction: 5 / 12 })], products: PRODUCTS });
    expect(result.missing).toEqual([expect.objectContaining({ key: "eggs", shortfallQuantity: 3, purchaseQuantity: 12, purchaseUnit: "each", aisle: "dairy" })]);
  });
});

// ─── Unknown quantities and products ────────────────────────────────────────

describe("computePlanRequirements — unknowns", () => {
  it("buys one package of an unquantified missing product, and nothing if any is at home", () => {
    const dish = meal("Herby rice", 4, [ing("parsley", "parsley"), ing("dill", "dill")]);
    const result = computePlanRequirements({ items: [plan("mon", MON, dish)], lots: [lot("dill", "dill", { remainingFraction: 0.3 })], products: PRODUCTS });
    expect(result.missing).toEqual([
      expect.objectContaining({ key: "parsley", shortfallQuantity: null, purchaseQuantity: 1, purchaseUnit: "bunch", reason: "For Monday's herby rice" }),
    ]);
  });

  it("keeps free-text ingredients by normalised name, as-is", () => {
    const dish = meal("Paella", 4, [ing("Saffron threads", null, 1, "pinch"), ing("sumac", null), ing("Lemongrass stalks", null, 1.5, "each")]);
    const result = computePlanRequirements({ items: [plan("mon", MON, dish)], lots: [], products: PRODUCTS });
    expect(result.missing.map((m) => [m.key, m.name, m.aisle, m.purchaseQuantity, m.purchaseUnit])).toEqual([
      ["name:saffron thread", "Saffron threads", "other", 1, "pinch"],
      ["name:sumac", "Sumac", "other", 1, "each"],
      ["name:lemongrass stalk", "Lemongrass stalks", "other", 2, "each"],
    ]);
  });

  it("adds convertible amounts but never apples to litres", () => {
    const monday = meal("Pad thai", 4, [ing("fish sauce", null, 2, "tbsp"), ing("lime", null, 1, "each")]);
    const wednesday = meal("Larb", 4, [ing("Fish sauce", null, 1, "bottle"), ing("fish sauce", null, 1, "tsp"), ing("limes", null, 2, "each")]);
    const result = computePlanRequirements({ items: [plan("mon", MON, monday), plan("wed", WED, wednesday)], lots: [], products: PRODUCTS });
    const [fishSauce, limes, bottle] = result.missing;
    // 2 tbsp + 1 tsp add up; a bottle can't be added to tablespoons without knowing its size.
    expect(fishSauce).toMatchObject({ key: "name:fish sauce", unit: "tbsp", forPlanItemIds: ["mon", "wed"] });
    expect(fishSauce.shortfallQuantity).toBeCloseTo(7 / 3, 3);
    expect(limes).toMatchObject({ key: "name:lime", shortfallQuantity: 3, unit: "each", purchaseQuantity: 3, forPlanItemIds: ["mon", "wed"] });
    expect(bottle).toMatchObject({ key: "name:fish sauce", shortfallQuantity: 1, unit: "bottle", purchaseQuantity: 1, forPlanItemIds: ["wed"] });
    expect(result.missing).toHaveLength(3);
  });

  it("covers garlic cloves by the presence of a bulb, and buys a bulb when there is none", () => {
    const dish = meal("Garlic bread", 4, [ing("garlic", "garlic", 3, "clove")]);
    const have = computePlanRequirements({ items: [plan("mon", MON, dish)], lots: [lot("garlic", "garlic", { quantity: 1 })], products: PRODUCTS });
    expect(have.missing).toEqual([]);
    const none = computePlanRequirements({ items: [plan("mon", MON, dish)], lots: [], products: PRODUCTS });
    expect(none.missing).toEqual([expect.objectContaining({ key: "garlic", shortfallQuantity: 3, unit: "clove", purchaseQuantity: 1, purchaseUnit: "each" })]);
  });

  it("keeps proper cuisine words capitalised in reasons", () => {
    const curry = meal("Thai green chicken curry", 4, [ing("coconut milk", "coconut-milk", 400, "ml")]);
    const result = computePlanRequirements({ items: [plan("tue", TUE, curry)], lots: [], products: PRODUCTS });
    expect(result.missing[0].reason).toBe("For Tuesday's Thai green chicken curry");
  });
});
