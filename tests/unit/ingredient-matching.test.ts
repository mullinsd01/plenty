import { describe, expect, it } from "vitest";
import { CATALOG, productInfoFromCatalog, type ProductInfo } from "@/lib/catalog";
import {
  assessMealAvailability,
  convertForProduct,
  findMatchingLots,
  isAssumedAvailable,
  lotRemaining,
  matchNames,
  summarizeAvailability,
} from "@/lib/meals/matching";
import type { IngredientAvailability, InventoryLot, MealIngredientInput, PlannableMeal } from "@/lib/meals/types";
import type { Unit } from "@/lib/units";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRODUCTS: ReadonlyMap<string, ProductInfo> = new Map(CATALOG.map((p) => [p.slug, productInfoFromCatalog(p)]));

function product(slug: string): ProductInfo {
  const found = PRODUCTS.get(slug);
  if (!found) throw new Error(`No catalog product ${slug}`);
  return found;
}

/** A lot of a catalog product (defaults: one full package, no expiry). */
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

/** A free-text lot with no product. */
function freeLot(id: string, name: string, quantity: number, unit: Unit, overrides: Partial<InventoryLot> = {}): InventoryLot {
  return { id, productId: null, name, quantity, unit, remainingFraction: 1, expiresOn: null, location: "fridge", ...overrides };
}

function ing(name: string, productId: string | null, quantity: number | null, unit: Unit | null, optional = false): MealIngredientInput {
  return { name, productId, quantity, unit, optional };
}

function meal(name: string, servings: number, ingredients: MealIngredientInput[]): PlannableMeal {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-"),
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    cuisine: "australian",
    timeMinutes: 20,
    difficulty: "easy",
    servings,
    mainIngredient: "eggs",
    tags: [],
    contains: [],
    ingredients,
    source: "library",
  };
}

function byName(items: IngredientAvailability[], name: string): IngredientAvailability {
  const found = items.find((i) => i.name === name);
  if (!found) throw new Error(`No ingredient ${name}`);
  return found;
}

const OMELETTE = meal("Spinach and cheese omelette", 2, [
  ing("eggs", "eggs", 6, "each"),
  ing("milk", "full-cream-milk", 100, "ml"),
  ing("baby spinach", null, 60, "g"),
  ing("cheddar", "cheddar-cheese", 50, "g"),
  ing("butter", "butter", 10, "g"),
  ing("salt", "salt", null, null),
  ing("black pepper", "black-pepper", null, null),
  ing("chives", "chives", 5, "g", true),
]);

// ─── lotRemaining ───────────────────────────────────────────────────────────

describe("lotRemaining", () => {
  it("expresses quantity × remaining fraction in the target unit", () => {
    const milk = lot("m", "full-cream-milk", { remainingFraction: 0.5 });
    expect(lotRemaining(milk, "ml", product("full-cream-milk"))).toBeCloseTo(1000);
    expect(lotRemaining(milk, "l")).toBeCloseTo(1);
    expect(lotRemaining(milk, "cup")).toBeCloseTo(4);
  });

  it("needs product knowledge to cross dimensions", () => {
    const eggs = lot("e", "eggs", { remainingFraction: 0.25 });
    expect(lotRemaining(eggs, "each")).toBeCloseTo(3);
    expect(lotRemaining(eggs, "g", product("eggs"))).toBeCloseTo(180);
    expect(lotRemaining(eggs, "g")).toBeNull();
    // Tomato paste has no density: grams can't become tablespoons.
    expect(lotRemaining(lot("tp", "tomato-paste"), "tbsp", product("tomato-paste"))).toBeNull();
  });

  it("reads a 'pack' as one catalog package of the product", () => {
    const mince = lot("bm", "beef-mince", { quantity: 2, unit: "pack", remainingFraction: 0.5 });
    expect(lotRemaining(mince, "g", product("beef-mince"))).toBeCloseTo(500);
    expect(lotRemaining(mince, "g")).toBeNull();
  });

  it("clamps nonsense fractions", () => {
    expect(lotRemaining(lot("m", "full-cream-milk", { remainingFraction: 1.4 }), "l")).toBeCloseTo(2);
    expect(lotRemaining(lot("m", "full-cream-milk", { remainingFraction: -0.2 }), "l")).toBe(0);
  });
});

describe("convertForProduct", () => {
  it("won't weigh a garlic clove as a whole bulb, or turn slices into loaves", () => {
    expect(convertForProduct(3, "clove", "each", product("garlic"))).toBeNull();
    expect(convertForProduct(3, "clove", "g", product("garlic"))).toBeNull();
    expect(convertForProduct(2, "slice", "loaf", product("white-bread"))).toBeNull();
    // Whole bulbs still weigh what the catalog says.
    expect(convertForProduct(2, "each", "g", product("garlic"))).toBeCloseTo(100);
  });
});

// ─── Name matching ──────────────────────────────────────────────────────────

describe("matchNames", () => {
  it.each([
    ["baby spinach", "Spinach", "exact"],
    ["tomatoes", "Cherry tomatoes", "exact"],
    ["chicken thigh fillets", "Chicken thigh", "exact"],
    ["garlic cloves", "Garlic", "exact"],
    ["extra virgin olive oil", "Olive oil", "exact"],
    ["full cream milk", "Milk", "exact"],
    ["red onion", "Brown onion", "similar"],
    ["lite milk", "Full cream milk", "similar"],
    ["whole milk", "Full cream milk", "exact"],
    ["long green chilli", "Chillies", "exact"],
    ["cilantro", "Coriander", "exact"],
    ["ground beef", "Beef mince", "exact"],
    ["zucchini", "Courgettes", "exact"],
  ] as const)("%s ↔ %s is %s", (a, b, expected) => {
    expect(matchNames(a, b)).toBe(expected);
  });

  it.each([
    ["chicken stock", "Chicken breast"],
    ["tomato paste", "Tomatoes"],
    ["milk", "Coconut milk"],
    ["potatoes", "Sweet potato"],
    ["spring onions", "Brown onion"],
    ["coriander", "Ground coriander"],
    ["butter", "Peanut butter"],
    ["cheese", "Cream cheese"],
    ["tomatoes", "Whole peeled tomatoes"],
    ["beef stock", "Chicken stock"],
    ["garlic", "Garlic bread"],
  ])("%s does not match %s", (a, b) => {
    expect(matchNames(a, b)).toBeNull();
  });
});

// ─── findMatchingLots ───────────────────────────────────────────────────────

describe("findMatchingLots", () => {
  const lots = [
    lot("fc-late", "full-cream-milk", { expiresOn: "2026-10-12" }),
    lot("lite", "lite-milk", { expiresOn: "2026-10-03" }),
    lot("fc-soon", "full-cream-milk", { expiresOn: "2026-10-05" }),
    lot("coconut", "coconut-milk"),
    lot("fc-empty", "full-cream-milk", { remainingFraction: 0.02 }),
    lot("skim", "skim-milk", { expiresOn: null }),
  ];

  it("splits exact product lots from same-group substitutes, soonest expiry first", () => {
    const found = findMatchingLots(ing("milk", "full-cream-milk", 250, "ml"), lots, PRODUCTS);
    expect(found.exact.map((l) => l.id)).toEqual(["fc-soon", "fc-late"]);
    expect(found.substitutes.map((l) => l.id)).toEqual(["lite", "skim"]);
  });

  it("never treats a different group as a substitute", () => {
    const found = findMatchingLots(ing("coconut milk", "coconut-milk", 400, "ml"), lots, PRODUCTS);
    expect(found.exact.map((l) => l.id)).toEqual(["coconut"]);
    expect(found.substitutes).toEqual([]);
  });

  it("falls back to names when the lot is free text", () => {
    const spinach = freeLot("sp", "Spinach", 120, "g");
    const found = findMatchingLots(ing("baby spinach", "baby-spinach", 60, "g"), [spinach], PRODUCTS);
    expect(found.exact.map((l) => l.id)).toEqual(["sp"]);
  });

  it("falls back to names when the ingredient is free text, avoiding false friends", () => {
    const pantry = [
      lot("breast", "chicken-breast"),
      lot("stock", "chicken-stock"),
      lot("paste", "tomato-paste"),
      lot("toms", "tomato"),
      lot("red", "red-onion"),
    ];
    const ids = (name: string) => {
      const found = findMatchingLots(ing(name, null, 1, "each"), pantry, PRODUCTS);
      return { exact: found.exact.map((l) => l.id), substitutes: found.substitutes.map((l) => l.id) };
    };
    expect(ids("chicken stock")).toEqual({ exact: ["stock"], substitutes: [] });
    expect(ids("tomato paste")).toEqual({ exact: ["paste"], substitutes: [] });
    expect(ids("tomatoes")).toEqual({ exact: ["toms"], substitutes: [] });
    expect(ids("brown onion")).toEqual({ exact: [], substitutes: ["red"] });
  });

  it("ignores non-food products", () => {
    const sponges = lot("sponges", "sponges");
    expect(product("sponges").nonFood).toBe(true);
    expect(matchNames("sponge", "Sponges")).toBe("exact");
    expect(findMatchingLots(ing("sponge", null, 1, "each"), [sponges], PRODUCTS)).toEqual({ exact: [], substitutes: [] });
  });
});

// ─── isAssumedAvailable ─────────────────────────────────────────────────────

describe("isAssumedAvailable", () => {
  it("assumes catalog pantry basics", () => {
    expect(isAssumedAvailable(ing("salt", "salt", null, null), product("salt"))).toBe(true);
    expect(isAssumedAvailable(ing("water", "water", 250, "ml"), product("water"))).toBe(true);
    expect(isAssumedAvailable(ing("olive oil", "olive-oil", 1, "tbsp"), product("olive-oil"))).toBe(false);
  });

  it.each(["water", "boiling water", "Sea salt flakes", "cracked black pepper", "Salt and pepper", "ice cubes", "Freshly ground black pepper"])(
    "assumes free-text %s",
    (name) => {
      expect(isAssumedAvailable(ing(name, null, null, null))).toBe(true);
    },
  );

  it.each(["red pepper", "ice cream", "coconut water", "salted butter", "cayenne pepper", "sparkling water"])("does not assume %s", (name) => {
    expect(isAssumedAvailable(ing(name, null, null, null))).toBe(false);
  });
});

// ─── assessMealAvailability ─────────────────────────────────────────────────

describe("assessMealAvailability", () => {
  const kitchen = [
    lot("eggs", "eggs", { remainingFraction: 0.5, expiresOn: "2026-10-20" }),
    lot("lite", "lite-milk", { remainingFraction: 0.1, expiresOn: "2026-10-09" }),
    freeLot("spinach", "Spinach", 120, "g", { remainingFraction: 0.4, expiresOn: "2026-10-06" }),
    lot("butter", "butter", { remainingFraction: 0.02 }),
    lot("coconut", "coconut-milk"),
  ];

  it("reports have / partial / missing / assumed / optional_missing for the base servings", () => {
    const result = assessMealAvailability(OMELETTE, kitchen, PRODUCTS, { servings: 2, date: "2026-10-05" });
    expect(result.map((i) => [i.name, i.status])).toEqual([
      ["eggs", "have"],
      ["milk", "have"],
      ["baby spinach", "have"],
      ["cheddar", "missing"],
      ["butter", "missing"],
      ["salt", "assumed"],
      ["black pepper", "assumed"],
      ["chives", "optional_missing"],
    ]);
    const milk = byName(result, "milk");
    expect(milk.substitute).toBe(true);
    expect(milk.matchedLotIds).toEqual(["lite"]);
    expect(milk.coveredQuantity).toBeCloseTo(100);
    const spinach = byName(result, "baby spinach");
    expect(spinach.coveredQuantity).toBeCloseTo(48);
    expect(spinach.usesSoonExpiring).toBe(true);
    expect(byName(result, "eggs").usesSoonExpiring).toBe(false);
  });

  it("scales quantities to the planned servings", () => {
    const result = assessMealAvailability(OMELETTE, kitchen, PRODUCTS, { servings: 4, date: "2026-10-05" });
    const eggs = byName(result, "eggs");
    expect(eggs.neededQuantity).toBe(12);
    expect(eggs.coveredQuantity).toBeCloseTo(6);
    expect(eggs.status).toBe("partial");
    expect(byName(result, "baby spinach").status).toBe("partial");
    expect(byName(result, "milk")).toMatchObject({ neededQuantity: 200, status: "have" });
  });

  it("uses exact lots before substitutes, even when a substitute expires sooner", () => {
    const lots = [lot("lite", "lite-milk", { expiresOn: "2026-10-06" }), lot("full", "full-cream-milk", { expiresOn: "2026-10-10" })];
    const [milk] = assessMealAvailability(meal("Milk", 1, [ing("milk", "full-cream-milk", 500, "ml")]), lots, PRODUCTS, {
      servings: 1,
      date: "2026-10-05",
    });
    expect(milk).toMatchObject({ status: "have", matchedLotIds: ["full"], substitute: false });
  });

  it("ignores stock that will have expired by the meal date", () => {
    const beforeMeal = assessMealAvailability(OMELETTE, kitchen, PRODUCTS, { servings: 2, date: "2026-10-07" });
    expect(byName(beforeMeal, "baby spinach").status).toBe("missing");
    const onExpiryDay = assessMealAvailability(OMELETTE, kitchen, PRODUCTS, { servings: 2, date: "2026-10-06" });
    expect(byName(onExpiryDay, "baby spinach").status).toBe("have");
  });

  it("stops two ingredients in one meal from claiming the same stock", () => {
    const dish = meal("Garlic prawns", 4, [ing("garlic (marinade)", "garlic", 30, "g"), ing("garlic (sauce)", "garlic", 40, "g")]);
    const result = assessMealAvailability(dish, [lot("garlic", "garlic", { quantity: 1 })], PRODUCTS, { servings: 4, date: "2026-10-05" });
    expect(result[0]).toMatchObject({ status: "have", coveredQuantity: 30 });
    expect(result[1].status).toBe("partial");
    expect(result[1].coveredQuantity).toBeCloseTo(20);
  });

  it("treats an unquantified or unmeasurable need as covered when a matching lot exists", () => {
    const dish = meal("Tacos", 4, [ing("coriander", "coriander", null, null), ing("tomato paste", "tomato-paste", 2, "tbsp"), ing("parsley", "parsley", null, null)]);
    const result = assessMealAvailability(dish, [lot("cor", "coriander"), lot("tp", "tomato-paste", { remainingFraction: 0.5 })], PRODUCTS, {
      servings: 4,
      date: "2026-10-05",
    });
    expect(result[0]).toMatchObject({ status: "have", matchedLotIds: ["cor"], coveredQuantity: null });
    expect(result[1]).toMatchObject({ status: "have", matchedLotIds: ["tp"] });
    expect(result[2].status).toBe("missing");
  });

  it("does not let a fridge of coconut milk stand in for dairy milk", () => {
    const [milk] = assessMealAvailability(meal("Pancakes", 4, [ing("milk", null, 300, "ml")]), [lot("coconut", "coconut-milk")], PRODUCTS, {
      servings: 4,
      date: "2026-10-05",
    });
    expect(milk.status).toBe("missing");
  });
});

// ─── summarizeAvailability ──────────────────────────────────────────────────

describe("summarizeAvailability", () => {
  it("counts partial as missing and credits the covered share", () => {
    const kitchen = [
      lot("eggs", "eggs", { remainingFraction: 0.5 }),
      lot("lite", "lite-milk", { expiresOn: "2026-10-07" }),
      freeLot("spinach", "Spinach", 120, "g", { remainingFraction: 0.4 }),
    ];
    const ingredients = assessMealAvailability(OMELETTE, kitchen, PRODUCTS, { servings: 4, date: "2026-10-05" });
    const summary = summarizeAvailability(ingredients);
    // milk have; eggs 6/12 and spinach 48/120 partial; cheddar and butter missing.
    expect(summary.haveCount).toBe(1);
    expect(summary.missingCount).toBe(4);
    expect(summary.coverage).toBeCloseTo((1 + 0.5 + 0.4) / 5);
    expect(summary.missingNames).toEqual(["eggs", "baby spinach", "cheddar", "butter"]);
    expect(summary.useSoonNames).toEqual(["milk"]);
  });

  it("is fully covered when everything needed is a pantry basic", () => {
    const result = assessMealAvailability(meal("Ice water", 1, [ing("ice", null, null, null), ing("water", null, 250, "ml")]), [], PRODUCTS, {
      servings: 1,
      date: "2026-10-05",
    });
    expect(summarizeAvailability(result)).toEqual({ haveCount: 0, missingCount: 0, coverage: 1, missingNames: [], useSoonNames: [] });
  });
});
