import { describe, expect, it } from "vitest";
import { addDays, DAY_MS } from "@/lib/dates";
import type { Cuisine } from "@/lib/domain";
import {
  AVERSION_NOTE_THRESHOLD,
  WEAK_AVERSION_CAP,
  catalogProductMap,
  computePlanRequirements,
  generatePlan,
  isWeeknight,
  learnAversions,
  libraryPlannableMeals,
  mainIngredientKey,
  noAversions,
  rankMealsForNow,
  requiredContains,
  scoreMeal,
  whenPhrase,
  type InventoryLot,
  type MealHistory,
  type PlannableMeal,
  type PlannedMeal,
  type PlannerContext,
  type PlannerPreferences,
  type ScoreMealOptions,
} from "@/lib/meals";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PRODUCTS = catalogProductMap();
const MEALS = libraryPlannableMeals();
const MEALS_BY_ID = new Map(MEALS.map((meal) => [meal.id, meal]));

function meal(id: string): PlannableMeal {
  const found = MEALS_BY_ID.get(id);
  if (!found) throw new Error(`No library meal ${id}`);
  return found;
}

// Monday 5 October 2026, early evening in Sydney.
const MON = "2026-10-05";
const TUE = "2026-10-06";
const WED = "2026-10-07";
const THU = "2026-10-08";
const FRI = "2026-10-09";
const SAT = "2026-10-10";
const SUN = "2026-10-11";
const WEEK = [MON, TUE, WED, THU, FRI, SAT, SUN];
const NOW = new Date("2026-10-05T07:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** One package of a catalog product (times `packs`), fresh and unopened. */
function lot(slug: string, overrides: Partial<InventoryLot> = {}, packs = 1): InventoryLot {
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

function lots(slugs: readonly string[], packs = 1): InventoryLot[] {
  return slugs.map((slug) => lot(slug, {}, packs));
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

function history(mealId: string, overrides: Partial<MealHistory> = {}): MealHistory {
  return {
    mealId,
    rating: 0,
    saved: false,
    timesPlanned: 0,
    timesCooked: 0,
    timesRejected: 0,
    lastPlannedAt: null,
    lastCookedAt: null,
    lastRejectedAt: null,
    ...overrides,
  };
}

function historyMap(...entries: MealHistory[]): ReadonlyMap<string, MealHistory> {
  return new Map(entries.map((entry) => [entry.mealId, entry]));
}

function context(inventory: InventoryLot[], overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    meals: MEALS,
    lots: inventory,
    products: PRODUCTS,
    prefs: prefs(),
    history: new Map(),
    today: MON,
    now: NOW,
    ...overrides,
  };
}

function scoreOn(dish: PlannableMeal, ctx: PlannerContext, overrides: Partial<ScoreMealOptions> = {}) {
  return scoreMeal(dish, ctx, { date: SAT, servings: 4, isWeeknight: false, seed: 0, ...overrides });
}

function scoreOf(dish: PlannableMeal, ctx: PlannerContext, overrides: Partial<ScoreMealOptions> = {}): number {
  const scored = scoreOn(dish, ctx, overrides);
  if (!scored) throw new Error(`${dish.id} was excluded`);
  return scored.score;
}

/** Every catalog product a meal needs (optional extras excluded). */
function requiredSlugs(dish: PlannableMeal): string[] {
  return dish.ingredients.filter((i) => !i.optional && i.productId !== null).map((i) => i.productId as string);
}

/** A kitchen stocked with everything the given meals need, three packs deep. */
function kitchenFor(...dishes: PlannableMeal[]): InventoryLot[] {
  return lots([...new Set(dishes.flatMap(requiredSlugs))], 3);
}

/** A typical Australian pantry and fridge with no fresh protein. */
const EVERYDAY_KITCHEN = [
  "olive-oil",
  "vegetable-oil",
  "garlic",
  "brown-onion",
  "soy-sauce",
  "jasmine-rice",
  "basmati-rice",
  "spaghetti",
  "penne",
  "crushed-tomatoes",
  "diced-tomatoes",
  "tomato-paste",
  "ground-cumin",
  "smoked-paprika",
  "dried-oregano",
  "eggs",
  "full-cream-milk",
  "butter",
  "parmesan",
  "cheddar-cheese",
  "carrot",
  "potato",
  "lemon",
  "frozen-peas",
  "chicken-stock",
  "vegetable-stock",
  "plain-flour",
  "white-sugar",
  "brown-sugar",
  "cornflour",
  "ginger",
  "chickpeas",
];

function mealsIn(plan: readonly PlannedMeal[]): PlannableMeal[] {
  return plan.map((item) => meal(item.mealId));
}

function daysDiffering(a: readonly PlannedMeal[], b: readonly PlannedMeal[]): number {
  return a.filter((item, i) => item.mealId !== b[i]?.mealId).length;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

describe("isWeeknight and whenPhrase", () => {
  it("treats Monday to Thursday as weeknights", () => {
    expect(WEEK.map(isWeeknight)).toEqual([true, true, true, true, false, false, false]);
  });

  it("describes a date relative to today", () => {
    expect(whenPhrase(MON, MON)).toBe("tonight");
    expect(whenPhrase(TUE, MON)).toBe("tomorrow");
    expect(whenPhrase(THU, MON)).toBe("on Thursday");
    expect(whenPhrase(addDays(MON, 10), MON)).toBe("on Thu 15 Oct");
  });
});

// ─── scoreMeal ──────────────────────────────────────────────────────────────

describe("scoreMeal", () => {
  it("rewards a meal the kitchen fully covers and says so", () => {
    const dal = meal("red-lentil-dal");
    const scored = scoreOn(dal, context(kitchenFor(dal)));
    expect(scored).not.toBeNull();
    expect(scored?.coverage).toBe(1);
    expect(scored?.missingCount).toBe(0);
    expect(scored?.primaryReason).toBe("You already have everything");
    // 40 for availability plus 3 for an easy meal, before jitter.
    expect(scored?.score).toBeGreaterThanOrEqual(43);
    expect(scored?.score).toBeLessThan(46);
  });

  it("counts what's missing and names a single missing ingredient", () => {
    const dal = meal("red-lentil-dal");
    const withoutLemon = kitchenFor(dal).filter((l) => l.productId !== "lemon");
    const scored = scoreOn(dal, context(withoutLemon));
    expect(scored?.missingCount).toBe(1);
    expect(scored?.missingNames).toEqual(["lemon"]);
    expect(scored?.reasons).toContain("You're only missing the lemon");
    expect(scored?.primaryReason).toMatch(/^Uses \d+ ingredients you already have$/);
    const withoutThree = kitchenFor(dal).filter((l) => !["lemon", "coriander", "red-lentils"].includes(l.productId ?? ""));
    expect(scoreOn(dal, context(withoutThree))?.reasons).toContain("You're missing 3 ingredients");
  });

  it("returns null for meals the household can't or won't eat", () => {
    const ctx = context([]);
    expect(scoreOn(meal("prawn-pad-thai"), { ...ctx, prefs: prefs({ allergies: ["peanuts"] }) })).toBeNull();
    expect(scoreOn(meal("beef-tacos"), { ...ctx, prefs: prefs({ diets: ["vegetarian"] }) })).toBeNull();
    expect(scoreOn(meal("mushroom-risotto"), { ...ctx, prefs: prefs({ dislikedIngredients: ["mushrooms"] }) })).toBeNull();
    expect(scoreOn(meal("beef-tacos"), { ...ctx, history: historyMap(history("beef-tacos", { rating: -1 })) })).toBeNull();
  });

  it("applies the weeknight time limit, and drops meals far over it", () => {
    const ctx = context([], { prefs: prefs({ weeknightMaxMinutes: 30 }) });
    const butterChicken = meal("butter-chicken"); // 40 minutes
    const bolognese = meal("spaghetti-bolognese"); // 55 minutes, more than 1.5 × 30
    const weeknight = scoreOf(butterChicken, ctx, { isWeeknight: true });
    const weekend = scoreOf(butterChicken, ctx, { isWeeknight: false });
    expect(weekend - weeknight).toBeCloseTo(20, 5);
    expect(scoreOn(bolognese, ctx, { isWeeknight: true })).toBeNull();
    expect(scoreOn(bolognese, ctx, { isWeeknight: false })).not.toBeNull();
    // No limit set: nothing changes.
    expect(scoreOn(bolognese, context([]), { isWeeknight: true })).not.toBeNull();
  });

  it("lifts favourites, saved meals and favourite cuisines", () => {
    const curry = meal("chicken-curry");
    const base = scoreOf(curry, context([]));
    const liked = scoreOn(curry, context([], { history: historyMap(history(curry.id, { rating: 1 })) }));
    expect((liked?.score ?? 0) - base).toBeCloseTo(12, 1);
    expect(liked?.reasons).toContain("A household favourite");
    const saved = scoreOn(curry, context([], { history: historyMap(history(curry.id, { saved: true })) }));
    expect((saved?.score ?? 0) - base).toBeCloseTo(6, 1);
    expect(saved?.reasons).toContain("One you've saved");
    const indianFans = scoreOn(curry, context([], { prefs: prefs({ favouriteCuisines: ["indian"] }) }));
    expect((indianFans?.score ?? 0) - base).toBeCloseTo(8, 1);
    expect(indianFans?.reasons).toContain("You love Indian food");
  });

  it("penalises rejections up to a cap", () => {
    const curry = meal("chicken-curry");
    const withRejections = (timesRejected: number) =>
      scoreOf(curry, context([], { history: historyMap(history(curry.id, { timesRejected })) }), { aversions: noAversions() });
    const base = scoreOf(curry, context([]), { aversions: noAversions() });
    expect(withRejections(1) - base).toBeCloseTo(-6, 1);
    expect(withRejections(2) - base).toBeCloseTo(-12, 1);
    expect(withRejections(5) - base).toBeCloseTo(-18, 1);
  });

  it("steers away from meals cooked or planned recently, measured from the meal's date", () => {
    const tacos = meal("beef-tacos");
    const base = scoreOf(tacos, context([]), { date: MON });
    const cookedWith = (days: number, date: string) =>
      scoreOf(tacos, context([], { history: historyMap(history(tacos.id, { timesCooked: 1, lastCookedAt: daysAgo(days) })) }), { date });
    // Cooked (and not rejected) earns +3; recency takes 15 within a week, 6 within a fortnight.
    expect(cookedWith(3, MON) - base).toBeCloseTo(3 - 15, 1);
    expect(cookedWith(10, MON) - base).toBeCloseTo(3 - 6, 1);
    expect(cookedWith(30, MON) - base).toBeCloseTo(3, 1);
    // Three days ago is eleven days before a meal next Friday.
    const nextFriday = addDays(FRI, 7);
    expect(cookedWith(3, nextFriday) - scoreOf(tacos, context([]), { date: nextFriday })).toBeCloseTo(3 - 6, 1);
    const planned = scoreOf(tacos, context([], { history: historyMap(history(tacos.id, { timesPlanned: 1, lastPlannedAt: daysAgo(2) })) }), { date: MON });
    expect(planned - base).toBeCloseTo(-8, 1);
  });

  it("charges for missing ingredients, twice as much on a tight budget", () => {
    const curry = meal("chicken-curry");
    const roomy = scoreOn(curry, context([], { prefs: prefs({ weeklyBudget: 250, householdSize: 2 }) }));
    const tight = scoreOn(curry, context([], { prefs: prefs({ weeklyBudget: 100, householdSize: 2 }) }));
    expect(roomy && tight).toBeTruthy();
    expect((roomy?.score ?? 0) - (tight?.score ?? 0)).toBeCloseTo(2 * (roomy?.missingCount ?? 0), 1);
    expect(roomy?.missingCount).toBeGreaterThan(10);
  });

  it("adds at most three points of deterministic jitter per seed", () => {
    const curry = meal("chicken-curry");
    const ctx = context(lots(EVERYDAY_KITCHEN));
    const scores = [1, 2, 3, 4, 5, 6].map((seed) => scoreOf(curry, ctx, { seed }));
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThanOrEqual(3);
    expect(new Set(scores).size).toBeGreaterThan(1);
    expect(scoreOf(curry, ctx, { seed: 4 })).toBe(scores[3]);
  });

  it("explains food about to go off, relative to the meal's date", () => {
    const gnocchi = meal("creamy-mushroom-and-spinach-gnocchi");
    const inventory = [...kitchenFor(gnocchi).filter((l) => l.productId !== "baby-spinach"), lot("baby-spinach", { expiresOn: WED })];
    const ctx = context(inventory);
    const reasonOn = (date: string) => scoreOn(gnocchi, ctx, { date })?.primaryReason;
    expect(reasonOn(MON)).toBe("Your baby spinach is likely to go off soon, so we've used it tonight.");
    expect(reasonOn(TUE)).toBe("Your baby spinach is likely to go off soon, so we've used it tomorrow.");
    expect(reasonOn(WED)).toBe("Your baby spinach is likely to go off soon, so we've used it on Wednesday.");
    expect(scoreOn(gnocchi, ctx, { date: MON })?.useSoonNames).toEqual(["baby spinach"]);
  });

  it("weights use-soon points by urgency and caps them", () => {
    const gnocchi = meal("creamy-mushroom-and-spinach-gnocchi");
    const fresh = kitchenFor(gnocchi);
    const expiring = (on: string, slugs: string[]) => fresh.map((l) => (slugs.includes(l.productId ?? "") ? { ...l, expiresOn: on } : l));
    const base = scoreOf(gnocchi, context(fresh), { date: MON });
    // Expires tomorrow: full 12 points. Three days out: half.
    expect(scoreOf(gnocchi, context(expiring(TUE, ["baby-spinach"])), { date: MON }) - base).toBeCloseTo(12, 1);
    expect(scoreOf(gnocchi, context(expiring(THU, ["baby-spinach"])), { date: MON }) - base).toBeCloseTo(6, 1);
    // Four items going off tomorrow still earn no more than 24.
    const many = expiring(TUE, ["baby-spinach", "mushrooms", "thickened-cream", "gnocchi"]);
    const scored = scoreOn(gnocchi, context(many), { date: MON });
    expect((scored?.score ?? 0) - base).toBeCloseTo(24, 1);
    expect(scored?.primaryReason).toMatch(/^Your .+ are likely to go off soon, so we've used them tonight\.$/);
  });

  it("leaves out optional ingredients the household avoids and says so", () => {
    const butterChicken = meal("butter-chicken");
    const scored = scoreOn(butterChicken, context(kitchenFor(butterChicken), { prefs: prefs({ dislikedIngredients: ["coriander"] }) }));
    expect(scored?.reasons[0]).toBe("You already have everything");
    expect(scored?.reasons[1]).toBe("Leave out the optional coriander");
    expect(scored?.ingredients.map((i) => i.name)).not.toContain("coriander");
  });
});

// ─── rankMealsForNow ────────────────────────────────────────────────────────

describe("rankMealsForNow", () => {
  it("puts a stir-fry first for a household with chicken, rice, broccoli and soy sauce", () => {
    const ctx = context(lots(["chicken-breast", "jasmine-rice", "broccoli", "soy-sauce"]));
    const ranked = rankMealsForNow(ctx);
    expect(ranked[0]?.meal.id).toBe("chicken-stir-fry");
    expect(ranked[0]?.haveCount).toBe(4);
  });

  it("puts the chicken stir-fry first in a stocked kitchen when the chicken needs using", () => {
    const inventory = [
      ...lots(["jasmine-rice", "broccoli", "soy-sauce", "garlic", "ginger", "vegetable-oil", "oyster-sauce", "cornflour", "brown-sugar", "sesame-oil", "red-capsicum", "spring-onion"]),
      lot("chicken-breast", { expiresOn: TUE }),
    ];
    const [top] = rankMealsForNow(context(inventory));
    expect(top?.meal.id).toBe("chicken-stir-fry");
    expect(top?.primaryReason).toBe("Your chicken breast is likely to go off soon, so we've used it tonight.");
  });

  it("ranks by availability bucket before anything else", () => {
    const aglio = meal("spaghetti-aglio-e-olio");
    const tomatoPasta = meal("pasta-with-tomato-sauce");
    const inventory = [...kitchenFor(aglio), ...kitchenFor(tomatoPasta).filter((l) => l.productId !== "basil")];
    const ctx = context(inventory, {
      meals: [tomatoPasta, aglio],
      history: historyMap(history(tomatoPasta.id, { rating: 1, saved: true, timesCooked: 6 })),
    });
    const ranked = rankMealsForNow(ctx);
    expect(ranked.map((s) => s.meal.id)).toEqual([aglio.id, tomatoPasta.id]);
    expect(ranked.map((s) => s.missingCount)).toEqual([0, 1]);
    // The favourite has the higher score; the ranking still puts "have everything" first.
    expect(ranked[1]?.score).toBeGreaterThan(ranked[0]?.score ?? 0);
  });

  it("prefers using food that's going off over favourites within a bucket, then quicker meals", () => {
    const frittata = meal("spinach-capsicum-and-feta-frittata"); // 30 minutes
    const dal = meal("red-lentil-dal"); // 35 minutes
    const aglio = meal("spaghetti-aglio-e-olio"); // 15 minutes
    const inventory = [
      ...kitchenFor(frittata).filter((l) => l.productId !== "baby-spinach"),
      lot("baby-spinach", { expiresOn: TUE }),
      ...kitchenFor(dal, aglio),
    ];
    const ctx = context(inventory, { meals: [aglio, dal, frittata], history: historyMap(history(dal.id, { rating: 1 })) });
    expect(rankMealsForNow(ctx).map((s) => s.meal.id)).toEqual([frittata.id, dal.id, aglio.id]);
  });

  it("excludes meals the household can't eat and honours limit and maxMinutes", () => {
    const ctx = context(lots(EVERYDAY_KITCHEN), { prefs: prefs({ diets: ["vegetarian"], allergies: ["shellfish"] }) });
    const ranked = rankMealsForNow(ctx, { limit: 64 });
    expect(ranked.length).toBeGreaterThan(10);
    for (const scored of ranked) {
      expect(requiredContains(scored.meal)).not.toEqual(expect.arrayContaining(["meat"]));
      for (const flag of ["meat", "pork", "poultry", "fish", "shellfish"] as const) expect(requiredContains(scored.meal)).not.toContain(flag);
    }
    expect(rankMealsForNow(ctx, { limit: 3 })).toHaveLength(3);
    const quick = rankMealsForNow(ctx, { limit: 64, maxMinutes: 20 });
    expect(quick.length).toBeGreaterThan(0);
    expect(quick.every((s) => s.meal.timeMinutes <= 20)).toBe(true);
  });

  it("orders buckets monotonically and uses today's weeknight limit", () => {
    const ctx = context(lots(EVERYDAY_KITCHEN), { prefs: prefs({ weeknightMaxMinutes: 30 }) });
    const ranked = rankMealsForNow(ctx, { limit: 64 });
    const buckets = ranked.map((s) => Math.min(s.missingCount, 3));
    expect([...buckets].sort((a, b) => a - b)).toEqual(buckets);
    // Monday: nothing over 45 minutes is offered.
    expect(ranked.every((s) => s.meal.timeMinutes <= 45)).toBe(true);
    const saturday = rankMealsForNow({ ...ctx, today: SAT }, { limit: 64 });
    expect(saturday.some((s) => s.meal.timeMinutes > 45)).toBe(true);
  });
});

// ─── generatePlan ───────────────────────────────────────────────────────────

describe("generatePlan", () => {
  it("uses spinach that's about to go off on the first night, whatever the seed", () => {
    const inventory = [...lots(EVERYDAY_KITCHEN), lot("baby-spinach", { expiresOn: TUE })];
    const ctx = context(inventory);
    for (const seed of [undefined, 1, 2, 3, 4, 5, 6]) {
      const plan = generatePlan(ctx, { dates: WEEK, servings: 4, seed });
      const first = plan[0];
      expect(first?.date).toBe(MON);
      expect(meal(first?.mealId ?? "").ingredients.some((i) => i.productId === "baby-spinach" && !i.optional)).toBe(true);
      expect(first?.reason).toBe("Your baby spinach is likely to go off soon, so we've used it tonight.");
    }
  });

  it("uses the soonest-expiring food on the earliest days", () => {
    const inventory = [...lots(EVERYDAY_KITCHEN), lot("baby-spinach", { expiresOn: TUE }), lot("chicken-thigh", { expiresOn: THU }, 2)];
    const plan = generatePlan(context(inventory), { dates: WEEK, servings: 4 });
    const usesSpinach = (item: PlannedMeal) => meal(item.mealId).ingredients.some((i) => i.productId === "baby-spinach");
    const usesChicken = (item: PlannedMeal) => meal(item.mealId).ingredients.some((i) => i.productId === "chicken-thigh");
    expect(usesSpinach(plan[0] as PlannedMeal)).toBe(true);
    const chickenNight = plan.find(usesChicken);
    expect(chickenNight).toBeDefined();
    expect(chickenNight && chickenNight.date <= THU).toBe(true);
    expect(chickenNight?.reason).toMatch(/chicken thigh.*likely to go off soon/i);
  });

  it("keeps a two-week plan varied", () => {
    const dates = Array.from({ length: 14 }, (_, i) => addDays(MON, i));
    const plan = generatePlan(context(lots(EVERYDAY_KITCHEN)), { dates, servings: 4, seed: 7 });
    expect(plan.map((p) => p.date)).toEqual(dates);
    const planned = mealsIn(plan);
    // No meal twice.
    expect(new Set(planned.map((m) => m.id)).size).toBe(planned.length);
    // Never the same main ingredient two nights running.
    for (let i = 1; i < planned.length; i++) {
      expect(mainIngredientKey(planned[i]?.mainIngredient ?? ""), `${plan[i - 1]?.mealId} → ${plan[i]?.mealId}`).not.toBe(mainIngredientKey(planned[i - 1]?.mainIngredient ?? "x"));
    }
    // At most two of a cuisine in any seven days.
    for (let start = 0; start + 7 <= plan.length; start++) {
      const counts = new Map<Cuisine, number>();
      for (const dish of planned.slice(start, start + 7)) counts.set(dish.cuisine, (counts.get(dish.cuisine) ?? 0) + 1);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    }
  });

  it("never lets two meals count the same pack of mince", () => {
    const tacos = meal("beef-tacos");
    const bolognese = meal("spaghetti-bolognese");
    const inventory = [...kitchenFor(tacos, bolognese).filter((l) => l.productId !== "beef-mince"), lot("beef-mince")];
    const ctx = context(inventory, { meals: [tacos, bolognese] });
    // On its own, either meal has everything.
    expect(scoreOn(tacos, ctx)?.missingCount).toBe(0);
    expect(scoreOn(bolognese, ctx)?.missingCount).toBe(0);

    const plan = generatePlan(ctx, { dates: [FRI, SUN], servings: 4 });
    expect(plan).toHaveLength(2);
    expect(plan[0]?.reason).toBe("You already have everything");
    expect(plan[1]?.reason).not.toBe("You already have everything");

    const requirements = computePlanRequirements({
      items: plan.map((p) => ({ planItemId: p.date, date: p.date, servings: 4, meal: meal(p.mealId) })),
      lots: inventory,
      products: PRODUCTS,
    });
    expect(requirements.missing.map((m) => [m.key, m.shortfallQuantity, m.forPlanItemIds])).toEqual([["beef-mince", 500, [SUN]]]);
  });

  it("claims kept meals' ingredients before planning open days", () => {
    const spinachCurry = meal("chickpea-and-spinach-curry");
    const inventory = [...lots(EVERYDAY_KITCHEN), lot("baby-spinach", { expiresOn: FRI })];
    const ctx = context(inventory);
    const free = generatePlan(ctx, { dates: [MON, TUE, WED, THU, FRI], servings: 4 });
    expect(free.some((p) => /spinach/.test(p.reason))).toBe(true);

    const withKeep = generatePlan(ctx, { dates: [MON, TUE, WED, THU, FRI], servings: 4, keep: [{ date: FRI, mealId: spinachCurry.id }] });
    expect(withKeep.find((p) => p.date === FRI)?.mealId).toBe(spinachCurry.id);
    expect(withKeep.filter((p) => p.date !== FRI).some((p) => /spinach/.test(p.reason))).toBe(false);
    expect(withKeep.filter((p) => p.mealId === spinachCurry.id)).toHaveLength(1);
  });

  it("replaces one day while keeping the rest of the week", () => {
    const ctx = context(lots(EVERYDAY_KITCHEN));
    const original = generatePlan(ctx, { dates: WEEK, servings: 4 });
    expect(original).toHaveLength(7);
    const wednesday = original.find((p) => p.date === WED);
    const keep = original.filter((p) => p.date !== WED).map(({ date, mealId }) => ({ date, mealId }));
    const replaced = generatePlan(ctx, { dates: WEEK, servings: 4, keep, exclude: [wednesday?.mealId ?? ""] });

    expect(replaced).toHaveLength(7);
    for (const item of replaced.filter((p) => p.date !== WED)) {
      expect(item.mealId).toBe(original.find((p) => p.date === item.date)?.mealId);
    }
    const newWednesday = replaced.find((p) => p.date === WED);
    expect(newWednesday?.mealId).not.toBe(wednesday?.mealId);
    expect(new Set(replaced.map((p) => p.mealId)).size).toBe(7);
    const main = mainIngredientKey(meal(newWednesday?.mealId ?? "").mainIngredient);
    for (const neighbour of [TUE, THU]) {
      expect(mainIngredientKey(meal(replaced.find((p) => p.date === neighbour)?.mealId ?? "").mainIngredient)).not.toBe(main);
    }
  });

  it("never picks excluded meals or meals the household can't eat", () => {
    const ctx = context(lots(EVERYDAY_KITCHEN), { prefs: prefs({ diets: ["vegetarian"] }) });
    const first = generatePlan(ctx, { dates: WEEK, servings: 4 });
    const exclude = first.map((p) => p.mealId);
    const second = generatePlan(ctx, { dates: WEEK, servings: 4, exclude });
    expect(second).toHaveLength(7);
    expect(second.some((p) => exclude.includes(p.mealId))).toBe(false);
    for (const dish of [...mealsIn(first), ...mealsIn(second)]) {
      expect(requiredContains(dish).some((flag) => ["meat", "pork", "poultry", "fish", "shellfish"].includes(flag))).toBe(false);
    }
  });

  it("produces noticeably different weeks for different seeds, and the same week for the same seed", () => {
    const ctx = context([]);
    const plans = [1, 2, 3, 4].map((seed) => generatePlan(ctx, { dates: WEEK, servings: 4, seed }));
    expect(generatePlan(ctx, { dates: WEEK, servings: 4, seed: 2 })).toEqual(plans[1]);
    const pairs = [
      [0, 1],
      [0, 2],
      [1, 2],
      [1, 3],
      [2, 3],
    ] as const;
    for (const [a, b] of pairs) expect(daysDiffering(plans[a] ?? [], plans[b] ?? [])).toBeGreaterThanOrEqual(3);
    const allMeals = new Set(plans.flatMap((plan) => plan.map((p) => p.mealId)));
    expect(allMeals.size).toBeGreaterThanOrEqual(10);
  });

  it("respects the weeknight time limit from Monday to Thursday", () => {
    const ctx = context(lots(EVERYDAY_KITCHEN), { prefs: prefs({ weeknightMaxMinutes: 30 }) });
    for (const seed of [undefined, 1, 2, 3]) {
      const plan = generatePlan(ctx, { dates: WEEK, servings: 4, seed });
      for (const item of plan.filter((p) => isWeeknight(p.date))) {
        expect(meal(item.mealId).timeMinutes, `${item.date} ${item.mealId}`).toBeLessThanOrEqual(30);
      }
    }
  });

  it("returns dates in order, ignores duplicates, and skips dates it can't fill", () => {
    const aglio = meal("spaghetti-aglio-e-olio");
    const dal = meal("red-lentil-dal");
    const ctx = context([], { meals: [aglio, dal] });
    const plan = generatePlan(ctx, { dates: [WED, MON, WED, TUE], servings: 2 });
    expect(plan.map((p) => p.date)).toEqual([MON, TUE]);
    expect(new Set(plan.map((p) => p.mealId))).toEqual(new Set([aglio.id, dal.id]));
  });

  it("ignores kept items for dates outside the plan or unknown meals", () => {
    const ctx = context(lots(EVERYDAY_KITCHEN));
    const plan = generatePlan(ctx, {
      dates: [MON, TUE],
      servings: 4,
      keep: [
        { date: SUN, mealId: "beef-tacos" },
        { date: MON, mealId: "no-such-meal" },
      ],
    });
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.mealId)).not.toContain("no-such-meal");
  });

  it("learns from rejections: a repeatedly skipped cuisine drops down the plan", () => {
    const thai = ["thai-green-chicken-curry", "prawn-pad-thai", "tofu-pad-see-ew"];
    const rejected = historyMap(...thai.map((id, i) => history(id, { timesPlanned: 2, timesRejected: i === 0 ? 2 : 1, lastRejectedAt: daysAgo(10) })));
    const basil = meal("thai-basil-pork-with-fried-eggs");
    const before = scoreOf(basil, context([]), { date: MON });
    const after = scoreOf(basil, context([], { history: rejected }), { date: MON });
    // Four rejections across three Thai meals → aversion 0.5 → 7.5 points off a Thai dish never rejected itself.
    expect(after - before).toBeCloseTo(-7.5, 1);

    // Both fully stocked: the quicker Thai dish leads until the household's pattern shows.
    const dal = meal("red-lentil-dal");
    const inventory = kitchenFor(basil, dal);
    const order = (ctx: PlannerContext) =>
      rankMealsForNow(ctx, { limit: 64 })
        .map((s) => s.meal.id)
        .filter((id) => id === basil.id || id === dal.id);
    expect(order(context(inventory))).toEqual([basil.id, dal.id]);
    expect(order(context(inventory, { history: rejected }))).toEqual([dal.id, basil.id]);
  });
});

// ─── learnAversions ─────────────────────────────────────────────────────────

describe("learnAversions", () => {
  it("builds a cuisine aversion from rejections spread across several meals", () => {
    const aversions = learnAversions(MEALS, [
      history("thai-green-chicken-curry", { timesRejected: 2 }),
      history("prawn-pad-thai", { timesRejected: 1 }),
      history("tofu-pad-see-ew", { timesRejected: 1 }),
    ]);
    expect(aversions.cuisines.get("thai")).toBeCloseTo(0.5, 3);
    expect(aversions.notes).toContain("You tend to skip Thai dishes");
  });

  it("needs at least three rejections before an aversion is more than mild", () => {
    const two = learnAversions(MEALS, [history("thai-green-chicken-curry", { timesRejected: 1 }), history("prawn-pad-thai", { timesRejected: 1 })]);
    expect(two.cuisines.get("thai")).toBeLessThanOrEqual(WEAK_AVERSION_CAP);
    expect(two.cuisines.get("thai")).toBeGreaterThan(0);
    expect(two.notes).toEqual([]);
    const three = learnAversions(MEALS, [history("thai-green-chicken-curry", { timesRejected: 2 }), history("prawn-pad-thai", { timesRejected: 1 })]);
    expect(three.cuisines.get("thai")).toBeGreaterThan(WEAK_AVERSION_CAP);
  });

  it("doesn't write off a cuisine because one dish keeps getting swapped", () => {
    const aversions = learnAversions(MEALS, [history("thai-green-chicken-curry", { timesRejected: 6 })]);
    expect(aversions.cuisines.get("thai")).toBeLessThanOrEqual(WEAK_AVERSION_CAP);
    expect(aversions.notes).toEqual([]);
  });

  it("learns main-ingredient aversions across cuisines", () => {
    const aversions = learnAversions(MEALS, [
      history("baked-fish-with-cherry-tomatoes-and-olives", { timesRejected: 2 }),
      history("oven-baked-fish-and-chips", { timesRejected: 1, rating: -1 }),
    ]);
    expect(aversions.mainIngredients.get("fish")).toBeGreaterThanOrEqual(AVERSION_NOTE_THRESHOLD);
    expect(aversions.notes).toEqual(["You tend to skip fish dishes"]);
    // Each cuisine saw only one of the dishes, so neither cuisine is blamed.
    expect(aversions.cuisines.get("mediterranean")).toBeLessThanOrEqual(WEAK_AVERSION_CAP);
    expect(aversions.cuisines.get("british")).toBeLessThanOrEqual(WEAK_AVERSION_CAP);
  });

  it("lets likes, saves and cooking offset rejections", () => {
    const aversions = learnAversions(MEALS, [
      history("thai-green-chicken-curry", { timesRejected: 2 }),
      history("prawn-pad-thai", { timesRejected: 1 }),
      history("tofu-pad-see-ew", { rating: 1, saved: true, timesCooked: 4 }),
    ]);
    expect(aversions.cuisines.get("thai") ?? 0).toBe(0);
    expect(aversions.notes).toEqual([]);
  });

  it("uses singular main-ingredient keys and ignores history for unknown meals", () => {
    expect(mainIngredientKey("Prawns")).toBe("prawn");
    expect(mainIngredientKey("black beans")).toBe("black bean");
    const aversions = learnAversions(MEALS, [history("not-a-meal", { timesRejected: 9 })]);
    expect(aversions.cuisines.size).toBe(0);
    expect(aversions.mainIngredients.size).toBe(0);
  });

  it("keeps weights between 0 and 1 however much evidence piles up", () => {
    const many = MEALS.filter((m) => m.cuisine === "italian").map((m) => history(m.id, { timesRejected: 20, rating: -1 }));
    const weight = learnAversions(MEALS, many).cuisines.get("italian") ?? 0;
    expect(weight).toBeGreaterThan(0.9);
    expect(weight).toBeLessThan(1);
  });
});
