/**
 * Regression tests from an adversarial review of the normaliser, ingredient
 * matching, plan requirements, shopping needs, planner and diet filtering.
 * Each block pins one defect that was found and fixed.
 */
import { describe, expect, it } from "vitest";
import {
  assessMealAvailability,
  catalogProductMap,
  computePlanRequirements,
  generatePlan,
  isMealAllowed,
  libraryPlannableMeals,
  matchNames,
  scoreMeal,
  type InventoryLot,
  type MealIngredientInput,
  type PlannableMeal,
  type PlannerContext,
  type PlannerPreferences,
} from "@/lib/meals";
import { cleanReceiptText, normalizeReceiptLine } from "@/lib/normalize";
import { stapleReason } from "@/lib/shopping";
import type { Unit } from "@/lib/units";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRODUCTS = catalogProductMap();
const MEALS = libraryPlannableMeals();
const MEALS_BY_SLUG = new Map(MEALS.map((meal) => [meal.slug, meal]));

/** Monday 5 October 2026. */
const MON = "2026-10-05";
const NOW = new Date("2026-10-05T07:00:00Z");

function libraryMeal(slug: string): PlannableMeal {
  const found = MEALS_BY_SLUG.get(slug);
  if (!found) throw new Error(`No library meal ${slug}`);
  return found;
}

/** Packages of a catalog product, fresh and unopened. */
function lot(slug: string, packs = 1, overrides: Partial<InventoryLot> = {}): InventoryLot {
  const product = PRODUCTS.get(slug);
  if (!product) throw new Error(`No catalog product ${slug}`);
  return {
    id: `lot-${slug}`,
    productId: slug,
    name: product.name,
    quantity: product.packageQuantity * packs,
    unit: product.unit,
    remainingFraction: 1,
    expiresOn: null,
    location: product.location,
    ...overrides,
  };
}

function freeLot(id: string, name: string, quantity: number, unit: Unit): InventoryLot {
  return { id, productId: null, name, quantity, unit, remainingFraction: 1, expiresOn: null, location: "pantry" };
}

function ing(name: string, productId: string | null, quantity: number | null, unit: Unit | null, optional = false): MealIngredientInput {
  return { name, productId, quantity, unit, optional };
}

function customMeal(name: string, ingredients: MealIngredientInput[], contains: PlannableMeal["contains"] = []): PlannableMeal {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  return {
    id: slug,
    slug,
    name,
    cuisine: "italian",
    timeMinutes: 20,
    difficulty: "easy",
    servings: 4,
    mainIngredient: ingredients[0]?.name ?? "",
    tags: [],
    contains,
    ingredients,
    source: "user",
  };
}

/** Every required ingredient of a library meal in the kitchen, in generous amounts. */
function kitchenFor(meal: PlannableMeal, except: readonly string[] = []): InventoryLot[] {
  const slugs = new Set(meal.ingredients.filter((i) => !i.optional && i.productId && !except.includes(i.productId)).map((i) => i.productId!));
  return [...slugs].map((slug) => lot(slug, 4));
}

function prefs(overrides: Partial<PlannerPreferences> = {}): PlannerPreferences {
  return {
    diets: [],
    allergies: [],
    dislikedIngredients: [],
    favouriteCuisines: [],
    weeknightMaxMinutes: null,
    householdSize: 2,
    weeklyBudget: null,
    ...overrides,
  };
}

function context(lots: InventoryLot[], overrides: Partial<PlannerContext> = {}): PlannerContext {
  return { meals: MEALS, lots, products: PRODUCTS, prefs: prefs(), history: new Map(), today: MON, now: NOW, ...overrides };
}

// ─── Substitutes never bring in what the dish doesn't already contain ──────

describe("substitutes and diet flags", () => {
  it("won't let chicken stock stand in for vegetable stock in a vegetarian risotto", () => {
    const risotto = libraryMeal("mushroom-risotto");
    const kitchen = [...kitchenFor(risotto, ["vegetable-stock"]), lot("chicken-stock", 2)];
    const stock = assessMealAvailability(risotto, kitchen, PRODUCTS, { servings: 4, date: MON }).find((i) => i.productId === "vegetable-stock");
    expect(stock).toMatchObject({ status: "missing", matchedLotIds: [], substitute: false });
  });

  it("tells a vegetarian household it still needs the vegetable stock", () => {
    const risotto = libraryMeal("mushroom-risotto");
    const kitchen = [...kitchenFor(risotto, ["vegetable-stock"]), lot("chicken-stock", 2)];
    const scored = scoreMeal(risotto, context(kitchen, { prefs: prefs({ diets: ["vegetarian"] }) }), { date: MON, servings: 4, isWeeknight: true });
    expect(scored?.missingNames).toEqual(["vegetable stock"]);
    expect(scored?.primaryReason).not.toBe("You already have everything");
  });

  it("puts corn tortillas on a gluten-free list even with wheat wraps in the pantry", () => {
    const tacos = libraryMeal("prawn-tacos-with-lime-slaw");
    const kitchen = [...kitchenFor(tacos, ["corn-tortillas"]), lot("wraps", 2)];
    const result = computePlanRequirements({ items: [{ planItemId: "p1", date: MON, servings: 4, meal: tacos }], lots: kitchen, products: PRODUCTS });
    expect(result.missing.map((m) => m.productId)).toEqual(["corn-tortillas"]);
    expect(result.meals[0]?.ingredients.find((i) => i.productId === "corn-tortillas")).toMatchObject({ status: "missing", substitute: false });
  });

  it("still substitutes when the dish already carries the flag, or the substitute carries less", () => {
    // Roast lamb is already a meat dish: beef stock can stand in for chicken stock.
    const lamb = libraryMeal("greek-roast-lamb-with-lemon-potatoes");
    const lambKitchen = [...kitchenFor(lamb, ["chicken-stock"]), lot("beef-stock", 2)];
    const lambStock = assessMealAvailability(lamb, lambKitchen, PRODUCTS, { servings: 6, date: MON }).find((i) => i.productId === "chicken-stock");
    expect(lambStock).toMatchObject({ status: "have", substitute: true, matchedLotIds: ["lot-beef-stock"] });
    // Vegetable stock adds nothing to a chicken curry.
    const curry = libraryMeal("thai-green-chicken-curry");
    const curryKitchen = [...kitchenFor(curry, ["chicken-stock"]), lot("vegetable-stock", 2)];
    const curryStock = assessMealAvailability(curry, curryKitchen, PRODUCTS, { servings: 4, date: MON }).find((i) => i.productId === "chicken-stock");
    expect(curryStock).toMatchObject({ status: "have", substitute: true });
  });
});

// ─── Multipack weights ──────────────────────────────────────────────────────

describe("pack counts beside a pack's net weight", () => {
  it("reads '8PK 500G' sausages as 500 g, not 4 kg", () => {
    expect(normalizeReceiptLine("WW BEEF SAUSAGES THIN 8PK 500G")).toMatchObject({ quantity: 500, unit: "g", packCount: 8 });
    expect(normalizeReceiptLine("PORK SAUSAGES 12S 1KG")).toMatchObject({ quantity: 1000, unit: "g", packCount: 12 });
    expect(normalizeReceiptLine("CHEESE SLICES 12PK 250G")).toMatchObject({ quantity: 250, unit: "g", packCount: 12 });
    expect(normalizeReceiptLine("SALMON PORTIONS 4PK 500G")).toMatchObject({ quantity: 500, unit: "g", packCount: 4 });
  });

  it("keeps the total for unmatched lines too", () => {
    expect(normalizeReceiptLine("ZXQV WIDGET 6PK 300G")).toMatchObject({ match: null, quantity: 300, unit: "g", packCount: 6 });
  });

  it("still multiplies sizes written with a multiplier, and drinks sold by the can", () => {
    expect(normalizeReceiptLine("COKE 24X375ML").quantity).toBe(9);
    expect(normalizeReceiptLine("BEEF MINCE 500G X2")).toMatchObject({ quantity: 1000, unit: "g" });
    expect(normalizeReceiptLine("COKE 10PK 375ML").quantity).toBeCloseTo(3.75);
    expect(normalizeReceiptLine("EGGS 12PK 700G")).toMatchObject({ quantity: 12, unit: "each" });
  });

  it("says which sizes cover the whole pack", () => {
    expect(cleanReceiptText("BEEF SAUSAGES 8PK 500G")).toMatchObject({ size: { quantity: 500, unit: "g" }, packCount: 8, sizeIsTotal: true });
    expect(cleanReceiptText("COKE 6X375ML")).toMatchObject({ packCount: 6, sizeIsTotal: false });
    expect(cleanReceiptText("CHIPS X6 150G")).toMatchObject({ packCount: 6, sizeIsTotal: false });
    expect(cleanReceiptText("BUTTER 250G")).toMatchObject({ packCount: null, sizeIsTotal: false });
  });
});

// ─── "Peppers" are capsicums (UK, US, NZ) ───────────────────────────────────

describe("peppers on receipts and in recipes", () => {
  it("never files a pack of peppers as ground black pepper", () => {
    expect(normalizeReceiptLine("PEPPERS").match?.product.slug).not.toBe("black-pepper");
    expect(normalizeReceiptLine("PEPPERS").match?.product.group).toBe("capsicum");
    expect(normalizeReceiptLine("TESCO MIXED PEPPERS 3PK").match?.product.group).toBe("capsicum");
    expect(normalizeReceiptLine("SWEET PEPPERS 500G").match?.product.group).toBe("capsicum");
  });

  it("still knows black pepper, peppercorns, pepperoni and Dr Pepper", () => {
    expect(normalizeReceiptLine("BLACK PEPPER 50G").match?.product.slug).toBe("black-pepper");
    expect(normalizeReceiptLine("PEPPER GROUND 50G").match?.product.slug).toBe("black-pepper");
    expect(normalizeReceiptLine("BLACK PEPPERCORNS").match?.product.slug).toBe("black-pepper");
    expect(normalizeReceiptLine("RED PEPPERS").match?.product.slug).toBe("red-capsicum");
    expect(normalizeReceiptLine("GREEN PEPPERS").match?.product.slug).toBe("green-capsicum");
    expect(normalizeReceiptLine("DR PEPPER 1.25L").match?.product.slug).toBe("soft-drink");
  });

  it("finds the capsicum in the fridge for a recipe's 'red peppers'", () => {
    expect(matchNames("red peppers", "red capsicum")).toBe("exact");
    expect(matchNames("bell peppers", "capsicum")).toBe("exact");
    expect(matchNames("peppers", "black pepper")).toBeNull();
  });
});

// ─── Seasonings and dislikes ────────────────────────────────────────────────

describe("dislikes and to-taste seasonings", () => {
  it("doesn't rule out a bolognese for 'peppers' because of the black pepper", () => {
    expect(isMealAllowed(libraryMeal("spaghetti-bolognese"), { diets: [], allergies: [], dislikedIngredients: ["peppers"] }, PRODUCTS)).toEqual({
      allowed: true,
      reason: null,
    });
    // Only dishes with actual peppers (capsicum) are ruled out; 36 of 64 used to be, for the seasoning.
    const blocked = MEALS.filter((m) => !isMealAllowed(m, { diets: [], allergies: [], dislikedIngredients: ["peppers"] }, PRODUCTS).allowed);
    for (const m of blocked) expect(m.ingredients.some((i) => !i.optional && /capsicum/.test(i.productId ?? "")), m.slug).toBe(true);
    expect(blocked.length).toBeLessThan(12);
  });

  it("reads a dislike of 'peppers' as capsicum, the way UK and US households mean it", () => {
    const peppers = { diets: [], allergies: [], dislikedIngredients: ["peppers"] };
    expect(isMealAllowed(libraryMeal("chicken-fajitas"), peppers, PRODUCTS)).toEqual({ allowed: false, reason: "Contains peppers, which you don't like" });
  });

  it("still honours a pepper dislike when peppers are a real ingredient", () => {
    const salad = customMeal("Roast pepper salad", [ing("roasted red peppers", null, 200, "g"), ing("rocket", "rocket", 60, "g"), ing("black pepper", "black-pepper", null, null)]);
    expect(isMealAllowed(salad, { diets: [], allergies: [], dislikedIngredients: ["peppers"] }, PRODUCTS)).toMatchObject({ allowed: false });
  });
});

// ─── Colour words that change what a thing is ───────────────────────────────

describe("colour words in free-text names", () => {
  it("never treats green beans, black beans, black pepper and red pepper as siblings", () => {
    expect(matchNames("black beans", "green beans")).toBeNull();
    expect(matchNames("red pepper", "black pepper")).toBeNull();
    expect(matchNames("green tea", "black tea")).toBeNull();
  });

  it("keeps colour a harmless variety elsewhere, and plainer forms still match", () => {
    expect(matchNames("red onion", "brown onion")).toBe("similar");
    expect(matchNames("red capsicum", "green capsicum")).toBe("similar");
    expect(matchNames("red kidney beans", "kidney beans")).toBe("exact");
  });

  it("doesn't count a bag of green beans as the black beans a recipe needs", () => {
    const bowl = customMeal("Bean bowl", [ing("black beans", null, 400, "g")]);
    const [beans] = assessMealAvailability(bowl, [freeLot("gb", "Green beans", 500, "g")], PRODUCTS, { servings: 4, date: MON });
    expect(beans).toMatchObject({ status: "missing", matchedLotIds: [] });
  });
});

// ─── Optional ingredients never leave a required one short ──────────────────

describe("optional ingredients claim stock last", () => {
  const pasta = customMeal("Parmesan pasta", [
    ing("parmesan, to serve", "parmesan", 40, "g", true),
    ing("spaghetti", "spaghetti", 500, "g"),
    ing("parmesan", "parmesan", 100, "g"),
  ]);
  const kitchen = [lot("parmesan", 0.5), lot("spaghetti")];

  it("covers the required parmesan before the garnish", () => {
    const availability = assessMealAvailability(pasta, kitchen, PRODUCTS, { servings: 4, date: MON });
    expect(availability.map((i) => [i.name, i.status])).toEqual([
      ["parmesan, to serve", "optional_missing"],
      ["spaghetti", "have"],
      ["parmesan", "have"],
    ]);
    expect(availability[2]).toMatchObject({ coveredQuantity: 100, matchedLotIds: ["lot-parmesan"] });
  });

  it("adds nothing to the list for a garnish", () => {
    const result = computePlanRequirements({ items: [{ planItemId: "p1", date: MON, servings: 4, meal: pasta }], lots: kitchen, products: PRODUCTS });
    expect(result.missing).toEqual([]);
    expect(result.meals[0]?.allAvailable).toBe(true);
  });

  it("won't buy coriander for Tuesday's tacos because Monday's soup was garnished with it", () => {
    // Monday's soup takes coriander only as an optional garnish; Tuesday's tacos need half a bunch.
    const soup = libraryMeal("roast-pumpkin-soup");
    const tacos = libraryMeal("prawn-tacos-with-lime-slaw");
    const kitchen = [
      ...kitchenFor(soup),
      ...kitchenFor(tacos, ["coriander"]).filter((l) => !kitchenFor(soup).some((s) => s.id === l.id)),
      lot("coriander", 1, { remainingFraction: 0.6 }),
    ];
    const result = computePlanRequirements({
      items: [
        { planItemId: "mon", date: MON, servings: 4, meal: soup },
        { planItemId: "tue", date: "2026-10-06", servings: 4, meal: tacos },
      ],
      lots: kitchen,
      products: PRODUCTS,
    });
    expect(result.missing).toEqual([]);
    expect(result.meals[1]?.ingredients.find((i) => i.productId === "coriander")).toMatchObject({ status: "have", coveredQuantity: 0.5 });
    // Monday's garnish gets what's left over.
    expect(result.meals[0]?.ingredients.find((i) => i.productId === "coriander")).toMatchObject({ status: "have", coveredQuantity: 0.1 });
  });
});

// ─── Saved plan reasons stay true on later days ─────────────────────────────

describe("plan reasons", () => {
  const gnocchi = libraryMeal("creamy-mushroom-and-spinach-gnocchi");
  const kitchen = [...kitchenFor(gnocchi, ["baby-spinach"]), lot("baby-spinach", 1, { expiresOn: "2026-10-07" })];

  it("names the day instead of saying 'tomorrow', which is wrong once the plan is read the next day", () => {
    const [tuesday] = generatePlan(context(kitchen, { meals: [gnocchi] }), { dates: ["2026-10-06"], servings: 4 });
    expect(tuesday?.reason).toBe("Your baby spinach is likely to go off soon, so we've used it on Tuesday.");
  });

  it("still says 'tonight' for today's dinner, and live scoring keeps 'tomorrow'", () => {
    const [monday] = generatePlan(context(kitchen, { meals: [gnocchi] }), { dates: [MON], servings: 4 });
    expect(monday?.reason).toBe("Your baby spinach is likely to go off soon, so we've used it tonight.");
    const live = scoreMeal(gnocchi, context(kitchen), { date: "2026-10-06", servings: 4, isWeeknight: true });
    expect(live?.primaryReason).toBe("Your baby spinach is likely to go off soon, so we've used it tomorrow.");
  });
});

// ─── Staple rhythm wording ──────────────────────────────────────────────────

describe("staple reasons", () => {
  it("never says 'every 1 weeks'", () => {
    expect(stapleReason(10)).toBe("You usually buy this every week");
    expect(stapleReason(10.4)).toBe("You usually buy this every week");
    expect(stapleReason(11)).toBe("You usually buy this every 2 weeks");
    for (let days = 1; days <= 90; days += 0.25) expect(stapleReason(days)).not.toMatch(/\bevery 1 \w+s\b/);
  });
});
