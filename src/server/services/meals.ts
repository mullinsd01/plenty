import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { ProductInfo } from "@/lib/catalog/types";
import { addDays, relativeDayLabel, toDateString, weekdayOf } from "@/lib/dates";
import {
  ALLERGEN_LABELS,
  COOKING_FREQUENCY_NIGHTS,
  CUISINE_LABELS,
  DIET_LABELS,
  DIFFICULTY_LABELS,
  type Allergen,
  type ContainsFlag,
  type CookingFrequency,
  type Cuisine,
  type Diet,
  type Difficulty,
} from "@/lib/domain";
import { ingredientsToOmit, isMealAllowed } from "@/lib/meals/diet";
import { assessMealAvailability, summarizeAvailability } from "@/lib/meals/matching";
import { generatePlan, rankMealsForNow, type PlannerContext } from "@/lib/meals/planner";
import { computePlanRequirements } from "@/lib/meals/requirements";
import type { IngredientAvailability, MealHistory, PlannableMeal, PlannerPreferences } from "@/lib/meals/types";
import { normalizeText } from "@/lib/normalize";
import { RECIPES, recipeContains } from "@/lib/recipes";
import { convert, formatQuantity, isUnit, type Unit } from "@/lib/units";
import { AIUnavailableError, getProvider, type GeneratedRecipe } from "@/server/ai";
import type { HouseholdContext } from "@/server/auth/context";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { systemDb, withUser, type Queryable, type Tx } from "@/server/db/client";
import {
  mealIngredients,
  mealPlanItems,
  mealPlans,
  mealPreferences,
  meals,
  preferences,
  products,
  type DbMealPlanItem,
} from "@/server/db/schema";
import { AppError, notFound } from "@/server/errors";
import { consumeForMealTx } from "./inventory";
import { computeLiveState, householdSizeOf, refreshLearning, type LiveState } from "./learning";
import { loadPlannableMeals, lotsFromLive } from "./meal-data";
import { notifyHousemates } from "./notifications";
import { loadProductIndex, resolveProduct } from "./products";
import { syncShoppingList } from "./shopping";

// ─── Library sync ───────────────────────────────────────────────────────────

/** Upsert the built-in recipe library as global meals. Idempotent. */
export async function syncRecipeLibrary(db: Queryable = systemDb): Promise<number> {
  const productRows = await db.select({ id: products.id, slug: products.slug }).from(products).where(isNull(products.householdId));
  const idBySlug = new Map(productRows.map((p) => [p.slug, p.id]));
  for (const recipe of RECIPES) {
    const values = {
      householdId: null,
      source: "library" as const,
      slug: recipe.slug,
      name: recipe.name,
      description: recipe.description,
      cuisine: recipe.cuisine,
      timeMinutes: recipe.timeMinutes,
      difficulty: recipe.difficulty,
      servings: recipe.servings,
      mainIngredient: recipe.mainIngredient,
      tags: recipe.tags,
      contains: recipeContains(recipe),
      steps: recipe.steps,
    };
    const [row] = await db
      .insert(meals)
      .values(values)
      .onConflictDoUpdate({
        target: meals.slug,
        targetWhere: sql`${meals.householdId} is null`,
        set: { ...values, updatedAt: sql`now()` },
      })
      .returning({ id: meals.id });
    await db.delete(mealIngredients).where(eq(mealIngredients.mealId, row.id));
    await db.insert(mealIngredients).values(
      recipe.ingredients.map((ing, position) => ({
        mealId: row.id,
        householdId: null,
        position,
        name: ing.name,
        productId: ing.product ? idBySlug.get(ing.product) ?? null : null,
        quantity: ing.quantity ?? null,
        unit: ing.unit ?? null,
        optional: ing.optional ?? false,
        note: ing.note ?? null,
      })),
    );
  }
  return RECIPES.length;
}

// ─── Context ────────────────────────────────────────────────────────────────

interface LoadedContext {
  planner: PlannerContext;
  live: LiveState;
  today: string;
  servings: number;
  nightsPerWeek: number;
  allowAi: boolean;
}

export function defaultServings(household: { adults: number; children: number }): number {
  return Math.max(2, household.adults + household.children);
}

async function loadContext(tx: Tx, ctx: HouseholdContext, now: Date, live?: LiveState): Promise<LoadedContext> {
  const state = live ?? (await computeLiveState(tx, ctx.household, now));
  const [prefs] = await tx.select().from(preferences).where(eq(preferences.householdId, ctx.household.id)).limit(1);
  const mealMap = await loadPlannableMeals(tx, ctx.household.id);
  const historyRows = await tx.select().from(mealPreferences).where(eq(mealPreferences.householdId, ctx.household.id));
  const history = new Map<string, MealHistory>(
    historyRows.map((h) => [
      h.mealId,
      {
        mealId: h.mealId,
        rating: (h.rating as -1 | 0 | 1) ?? 0,
        saved: h.saved,
        timesPlanned: h.timesPlanned,
        timesCooked: h.timesCooked,
        timesRejected: h.timesRejected,
        lastPlannedAt: h.lastPlannedAt,
        lastCookedAt: h.lastCookedAt,
        lastRejectedAt: h.lastRejectedAt,
      },
    ]),
  );
  const plannerPrefs: PlannerPreferences = {
    diets: (prefs?.diets ?? []) as Diet[],
    allergies: (prefs?.allergies ?? []) as Allergen[],
    dislikedIngredients: prefs?.dislikedIngredients ?? [],
    favouriteCuisines: (prefs?.favouriteCuisines ?? []) as Cuisine[],
    weeknightMaxMinutes: prefs?.weeknightMaxMinutes ?? null,
    householdSize: householdSizeOf(ctx.household),
    weeklyBudget: prefs?.weeklyBudget ?? null,
  };
  const today = toDateString(now, ctx.household.timezone);
  return {
    planner: {
      meals: [...mealMap.values()],
      lots: lotsFromLive(state),
      products: state.index.byId,
      prefs: plannerPrefs,
      history,
      today,
      now,
    },
    live: state,
    today,
    servings: defaultServings(ctx.household),
    nightsPerWeek: COOKING_FREQUENCY_NIGHTS[(prefs?.cookingFrequency as CookingFrequency | null) ?? "most_nights"],
    allowAi: prefs?.allowAiProcessing ?? true,
  };
}

// ─── Views ──────────────────────────────────────────────────────────────────

export interface MealCardView {
  id: string;
  name: string;
  description: string;
  cuisine: Cuisine;
  cuisineLabel: string;
  timeMinutes: number;
  difficulty: Difficulty;
  difficultyLabel: string;
  servings: number;
  mainIngredient: string;
  tags: string[];
  source: "library" | "ai" | "user";
  haveCount: number;
  missingCount: number;
  missingNames: string[];
  useSoonNames: string[];
  reason: string | null;
  rating: -1 | 0 | 1;
  saved: boolean;
}

function toCard(
  meal: PlannableMeal,
  ingredients: IngredientAvailability[],
  history: MealHistory | undefined,
  reason: string | null,
  description: string,
): MealCardView {
  const summary = summarizeAvailability(ingredients);
  return {
    id: meal.id,
    name: meal.name,
    description,
    cuisine: meal.cuisine,
    cuisineLabel: CUISINE_LABELS[meal.cuisine] ?? "Recipe",
    timeMinutes: meal.timeMinutes,
    difficulty: meal.difficulty,
    difficultyLabel: DIFFICULTY_LABELS[meal.difficulty],
    servings: meal.servings,
    mainIngredient: meal.mainIngredient,
    tags: meal.tags,
    source: meal.source,
    haveCount: summary.haveCount,
    missingCount: summary.missingCount,
    missingNames: summary.missingNames,
    useSoonNames: summary.useSoonNames,
    reason,
    rating: history?.rating ?? 0,
    saved: history?.saved ?? false,
  };
}

async function descriptions(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: meals.id, description: meals.description }).from(meals).where(inArray(meals.id, ids));
  return new Map(rows.map((r) => [r.id, r.description]));
}

export interface PlanItemView {
  id: string;
  date: string;
  dateLabel: string;
  isToday: boolean;
  servings: number;
  status: DbMealPlanItem["status"];
  reason: string | null;
  meal: MealCardView;
}

export interface MealPlanView {
  today: string;
  days: Array<{ date: string; label: string; item: PlanItemView | null }>;
  servings: number;
  nightsPerWeek: number;
}

async function planItemViews(tx: Tx, loaded: LoadedContext, rows: DbMealPlanItem[]): Promise<PlanItemView[]> {
  const mealsById = new Map(loaded.planner.meals.map((m) => [m.id, m]));
  const planned = rows.filter((r) => r.status === "planned" && mealsById.has(r.mealId));
  const requirements = computePlanRequirements({
    items: planned.map((r) => ({ planItemId: r.id, date: r.date, servings: r.servings, meal: mealsById.get(r.mealId)! })),
    lots: loaded.planner.lots,
    products: loaded.planner.products,
  });
  const perItem = new Map(requirements.meals.map((m) => [m.planItemId, m.ingredients]));
  const desc = await descriptions(tx, rows.map((r) => r.mealId));
  const out: PlanItemView[] = [];
  for (const r of rows) {
    const meal = mealsById.get(r.mealId);
    if (!meal) continue;
    const ingredients =
      perItem.get(r.id) ??
      assessMealAvailability(meal, loaded.planner.lots, loaded.planner.products, { servings: r.servings, date: r.date });
    out.push({
      id: r.id,
      date: r.date,
      dateLabel: relativeDayLabel(r.date, loaded.today),
      isToday: r.date === loaded.today,
      servings: r.servings,
      status: r.status,
      reason: r.reason,
      meal: toCard(meal, ingredients, loaded.planner.history.get(meal.id), r.reason, desc.get(meal.id) ?? ""),
    });
  }
  return out;
}

/** The coming week of dinners with live ingredient availability. */
export async function getMealPlan(ctx: HouseholdContext, now = new Date()): Promise<MealPlanView> {
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const end = addDays(loaded.today, 6);
    const rows = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), gte(mealPlanItems.date, loaded.today), lte(mealPlanItems.date, end), eq(mealPlanItems.slot, "dinner")))
      .orderBy(asc(mealPlanItems.date));
    const views = await planItemViews(tx, loaded, rows);
    const byDate = new Map(views.map((v) => [v.date, v]));
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(loaded.today, i);
      return { date, label: relativeDayLabel(date, loaded.today), item: byDate.get(date) ?? null };
    });
    return { today: loaded.today, days, servings: loaded.servings, nightsPerWeek: loaded.nightsPerWeek };
  });
}

// ─── Planning ───────────────────────────────────────────────────────────────

export type PlanRange = "tonight" | "tomorrow" | "3days" | "week";

/** Pick which nights to plan. A household that cooks 5 nights a week gets 5 dinners, weekends left free first. */
function planDates(range: PlanRange, today: string, nightsPerWeek: number): string[] {
  if (range === "tonight") return [today];
  if (range === "tomorrow") return [addDays(today, 1)];
  if (range === "3days") return [0, 1, 2].map((i) => addDays(today, i));
  const all = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  if (nightsPerWeek >= 7) return all;
  const dropOrder = [5, 6, 0, 4, 3, 2, 1]; // Fri, Sat, Sun … are the likeliest takeaway / eat-out nights
  const toDrop = 7 - Math.max(1, nightsPerWeek);
  const dropped = new Set<string>();
  for (const weekday of dropOrder) {
    if (dropped.size >= toDrop) break;
    const date = all.find((d) => weekdayOf(d) === weekday && d !== today);
    if (date) dropped.add(date);
  }
  return all.filter((d) => !dropped.has(d));
}

async function activePlanId(tx: Tx, householdId: string, today: string, userId: string): Promise<string> {
  const [plan] = await tx
    .select()
    .from(mealPlans)
    .where(and(eq(mealPlans.householdId, householdId), eq(mealPlans.status, "active")))
    .orderBy(desc(mealPlans.createdAt))
    .limit(1);
  if (plan) return plan.id;
  const [created] = await tx
    .insert(mealPlans)
    .values({ householdId, startDate: today, endDate: addDays(today, 6), createdBy: userId })
    .returning({ id: mealPlans.id });
  return created.id;
}

async function bumpPreference(tx: Tx, householdId: string, mealId: string, field: "planned" | "cooked" | "rejected", now: Date) {
  const inc =
    field === "planned"
      ? { timesPlanned: sql`${mealPreferences.timesPlanned} + 1`, lastPlannedAt: now }
      : field === "cooked"
        ? { timesCooked: sql`${mealPreferences.timesCooked} + 1`, lastCookedAt: now }
        : { timesRejected: sql`${mealPreferences.timesRejected} + 1`, lastRejectedAt: now };
  await tx
    .insert(mealPreferences)
    .values({
      householdId,
      mealId,
      timesPlanned: field === "planned" ? 1 : 0,
      timesCooked: field === "cooked" ? 1 : 0,
      timesRejected: field === "rejected" ? 1 : 0,
      lastPlannedAt: field === "planned" ? now : null,
      lastCookedAt: field === "cooked" ? now : null,
      lastRejectedAt: field === "rejected" ? now : null,
    })
    .onConflictDoUpdate({ target: [mealPreferences.householdId, mealPreferences.mealId], set: inc });
}

function seedFrom(now: Date): number {
  return Math.floor(now.getTime() / 1000) % 100_000;
}

/**
 * Plan dinners for a range. Existing plans are kept unless `regenerate` is
 * set; the planner uses what's in the kitchen (soonest-expiring first),
 * preferences, history and variety — all deterministic for a given seed.
 */
export async function generateMealPlan(
  ctx: HouseholdContext,
  range: PlanRange,
  opts: { regenerate?: boolean } = {},
): Promise<{ planned: number }> {
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const dates = planDates(range, loaded.today, loaded.nightsPerWeek);
    const planId = await activePlanId(tx, ctx.household.id, loaded.today, ctx.user.id);
    const existing = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), gte(mealPlanItems.date, loaded.today), eq(mealPlanItems.slot, "dinner")));

    const targetDates = new Set(dates);
    const replaceable = existing.filter((e) => targetDates.has(e.date) && e.status === "planned" && opts.regenerate);
    const keep = existing
      .filter((e) => e.status !== "skipped" && !replaceable.some((r) => r.id === e.id))
      .map((e) => ({ date: e.date, mealId: e.mealId }));
    const openDates = dates.filter((d) => !keep.some((k) => k.date === d));
    if (openDates.length === 0) return { planned: 0 };

    const picks = generatePlan(loaded.planner, {
      dates: openDates,
      servings: loaded.servings,
      keep,
      exclude: replaceable.map((r) => r.mealId),
      seed: seedFrom(now),
    });
    if (picks.length === 0) {
      throw new AppError("not_found", "Plenty couldn't find meals that fit your preferences. Try relaxing a dislike or allergy filter.");
    }
    for (const r of replaceable) {
      await tx.delete(mealPlanItems).where(eq(mealPlanItems.id, r.id));
    }
    for (const pick of picks) {
      await tx
        .insert(mealPlanItems)
        .values({
          mealPlanId: planId,
          householdId: ctx.household.id,
          date: pick.date,
          slot: "dinner",
          mealId: pick.mealId,
          servings: loaded.servings,
          reason: pick.reason,
        })
        .onConflictDoUpdate({
          target: [mealPlanItems.mealPlanId, mealPlanItems.date, mealPlanItems.slot],
          set: { mealId: pick.mealId, reason: pick.reason, status: "planned", servings: loaded.servings },
        });
      await bumpPreference(tx, ctx.household.id, pick.mealId, "planned", now);
    }
    const lastDate = picks.map((p) => p.date).sort().at(-1)!;
    await tx
      .update(mealPlans)
      .set({ endDate: sql`greatest(${mealPlans.endDate}, ${lastDate}::date)` })
      .where(eq(mealPlans.id, planId));
    if (range === "week" || range === "3days") {
      await notifyHousemates(tx, ctx.household, ctx.user.id, {
        type: "meal_plan_ready",
        title: range === "week" ? "Your weekly meal plan is ready" : "Dinners are planned for the next few days",
        body: `${ctx.user.displayName} planned ${picks.length} dinners. Missing ingredients are on the shopping list.`,
        link: "/meals",
        dedupeKey: `meal_plan:${planId}:${loaded.today}:${range}`,
      });
    }
    await syncShoppingList(tx, ctx.household, now, loaded.live);
    return { planned: picks.length };
  });
}

async function loadPlanItem(tx: Tx, householdId: string, id: string): Promise<DbMealPlanItem> {
  const [row] = await tx
    .select()
    .from(mealPlanItems)
    .where(and(eq(mealPlanItems.id, id), eq(mealPlanItems.householdId, householdId)))
    .limit(1);
  if (!row) throw notFound("That planned meal");
  return row;
}

/** Swap one planned meal for the next best option. Counts as a (soft) rejection of the old one. */
export async function replacePlanItem(ctx: HouseholdContext, itemId: string, opts: { dislike?: boolean } = {}): Promise<{ mealName: string }> {
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const item = await loadPlanItem(tx, ctx.household.id, itemId);
    if (item.status !== "planned") throw new AppError("conflict", "That meal has already been cooked.");
    await bumpPreference(tx, ctx.household.id, item.mealId, "rejected", now);
    if (opts.dislike) {
      await tx
        .update(mealPreferences)
        .set({ rating: -1, saved: false })
        .where(and(eq(mealPreferences.householdId, ctx.household.id), eq(mealPreferences.mealId, item.mealId)));
    }
    const loaded = await loadContext(tx, ctx, now);
    const others = await tx
      .select({ date: mealPlanItems.date, mealId: mealPlanItems.mealId })
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), gte(mealPlanItems.date, loaded.today), sql`${mealPlanItems.id} <> ${itemId}`));
    const [pick] = generatePlan(loaded.planner, {
      dates: [item.date],
      servings: item.servings,
      keep: others,
      exclude: [item.mealId],
      seed: seedFrom(now),
    });
    if (!pick) throw new AppError("not_found", "There's nothing else that fits right now. Try adjusting your preferences.");
    await tx.update(mealPlanItems).set({ mealId: pick.mealId, reason: pick.reason }).where(eq(mealPlanItems.id, itemId));
    await bumpPreference(tx, ctx.household.id, pick.mealId, "planned", now);
    await syncShoppingList(tx, ctx.household, now, loaded.live);
    return { mealName: loaded.planner.meals.find((m) => m.id === pick.mealId)?.name ?? "a new meal" };
  });
}

export async function removePlanItem(ctx: HouseholdContext, itemId: string): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadPlanItem(tx, ctx.household.id, itemId);
    await tx.delete(mealPlanItems).where(eq(mealPlanItems.id, item.id));
    await syncShoppingList(tx, ctx.household, now);
  });
}

export async function setPlanItemServings(ctx: HouseholdContext, itemId: string, servings: number): Promise<void> {
  if (!Number.isInteger(servings) || servings < 1 || servings > 24) throw new AppError("validation", "Servings must be between 1 and 24.");
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    await loadPlanItem(tx, ctx.household.id, itemId);
    await tx.update(mealPlanItems).set({ servings }).where(eq(mealPlanItems.id, itemId));
    await syncShoppingList(tx, ctx.household, now);
  });
}

/** Move a planned meal to another day (swapping with whatever is there). */
export async function movePlanItem(ctx: HouseholdContext, itemId: string, date: string): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadPlanItem(tx, ctx.household.id, itemId);
    const today = toDateString(now, ctx.household.timezone);
    if (date < today || date > addDays(today, 13)) throw new AppError("validation", "Pick a day in the next two weeks.");
    const [other] = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), eq(mealPlanItems.date, date), eq(mealPlanItems.slot, item.slot)))
      .limit(1);
    if (other && other.id !== item.id) {
      await tx.update(mealPlanItems).set({ date: "1900-01-01" }).where(eq(mealPlanItems.id, other.id));
      await tx.update(mealPlanItems).set({ date, mealPlanId: other.mealPlanId }).where(eq(mealPlanItems.id, item.id));
      await tx.update(mealPlanItems).set({ date: item.date, mealPlanId: item.mealPlanId }).where(eq(mealPlanItems.id, other.id));
    } else {
      await tx.update(mealPlanItems).set({ date }).where(eq(mealPlanItems.id, item.id));
    }
    await syncShoppingList(tx, ctx.household, now);
  });
}

export async function addMealToPlan(ctx: HouseholdContext, mealId: string, date: string): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const today = toDateString(now, ctx.household.timezone);
    if (date < today || date > addDays(today, 13)) throw new AppError("validation", "Pick a day in the next two weeks.");
    const visible = await loadPlannableMeals(tx, ctx.household.id, [mealId]);
    if (!visible.has(mealId)) throw notFound("That meal");
    const planId = await activePlanId(tx, ctx.household.id, today, ctx.user.id);
    await tx
      .insert(mealPlanItems)
      .values({
        mealPlanId: planId,
        householdId: ctx.household.id,
        date,
        slot: "dinner",
        mealId,
        servings: defaultServings(ctx.household),
        reason: "You picked this one",
      })
      .onConflictDoUpdate({
        target: [mealPlanItems.mealPlanId, mealPlanItems.date, mealPlanItems.slot],
        set: { mealId, reason: "You picked this one", status: "planned" },
      });
    await tx
      .update(mealPlans)
      .set({ endDate: sql`greatest(${mealPlans.endDate}, ${date}::date)` })
      .where(eq(mealPlans.id, planId));
    await bumpPreference(tx, ctx.household.id, mealId, "planned", now);
    await syncShoppingList(tx, ctx.household, now);
  });
}

/**
 * "We cooked it": deduct the ingredients the meal used from the kitchen, so
 * nobody has to update quantities by hand, and remember the household made it.
 */
export async function markPlanItemCooked(ctx: HouseholdContext, itemId: string): Promise<{ usedItems: number }> {
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const item = await loadPlanItem(tx, ctx.household.id, itemId);
    if (item.status === "cooked") return { usedItems: 0 };
    const loaded = await loadContext(tx, ctx, now);
    const meal = loaded.planner.meals.find((m) => m.id === item.mealId);
    if (!meal) throw notFound("That meal");
    const usage = allocationFor(meal, loaded, item.servings, loaded.today);
    const touched = await consumeForMealTx(tx, ctx.household, ctx.user.id, usage, item.id, now);
    await tx.update(mealPlanItems).set({ status: "cooked", cookedAt: now }).where(eq(mealPlanItems.id, item.id));
    await bumpPreference(tx, ctx.household.id, item.mealId, "cooked", now);
    await refreshLearning(tx, ctx.household, touched, now);
    await syncShoppingList(tx, ctx.household, now);
    return { usedItems: usage.length };
  });
}

/** Cook something off-plan (from "What can I make?" or a recipe page). */
export async function cookMealNow(ctx: HouseholdContext, mealId: string, servings?: number): Promise<{ usedItems: number }> {
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const meal = loaded.planner.meals.find((m) => m.id === mealId);
    if (!meal) throw notFound("That meal");
    const usage = allocationFor(meal, loaded, servings ?? loaded.servings, loaded.today);
    const touched = await consumeForMealTx(tx, ctx.household, ctx.user.id, usage, null, now);
    const [planned] = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), eq(mealPlanItems.date, loaded.today), eq(mealPlanItems.mealId, mealId)))
      .limit(1);
    if (planned) await tx.update(mealPlanItems).set({ status: "cooked", cookedAt: now }).where(eq(mealPlanItems.id, planned.id));
    await bumpPreference(tx, ctx.household.id, mealId, "cooked", now);
    await refreshLearning(tx, ctx.household, touched, now);
    await syncShoppingList(tx, ctx.household, now);
    return { usedItems: usage.length };
  });
}

/** Which inventory items (and how much of each, in the item's unit) a meal would use. */
function allocationFor(meal: PlannableMeal, loaded: LoadedContext, servings: number, date: string): Array<{ itemId: string; amount: number }> {
  const req = computePlanRequirements({
    items: [{ planItemId: "now", date, servings, meal }],
    lots: loaded.planner.lots,
    products: loaded.planner.products,
  });
  const ingredients = req.meals[0]?.ingredients ?? [];
  const usage: Array<{ itemId: string; amount: number }> = [];
  for (const ing of ingredients) {
    if (ing.status === "assumed" || ing.matchedLotIds.length === 0) continue;
    let remainingNeed = ing.coveredQuantity;
    for (const lotId of ing.matchedLotIds) {
      const lot = loaded.planner.lots.find((l) => l.id === lotId);
      if (!lot) continue;
      const available = lot.quantity * lot.remainingFraction;
      if (remainingNeed === null || ing.unit === null) {
        // Unquantified ingredient ("a handful"): assume a modest share of the pack.
        usage.push({ itemId: lot.id, amount: Math.min(available, lot.quantity * 0.2) });
        break;
      }
      const inLotUnit = convertNeed(remainingNeed, ing.unit, lot.unit, loaded.planner.products.get(lot.productId ?? ""));
      if (inLotUnit === null) {
        usage.push({ itemId: lot.id, amount: Math.min(available, lot.quantity * 0.25) });
        break;
      }
      const take = Math.min(available, inLotUnit);
      if (take > 0) usage.push({ itemId: lot.id, amount: take });
      const leftInLotUnit = inLotUnit - take;
      if (leftInLotUnit <= 1e-9) break;
      remainingNeed = remainingNeed * (leftInLotUnit / inLotUnit);
    }
  }
  return usage;
}

function convertNeed(amount: number, from: Unit, to: Unit, product: ProductInfo | undefined): number | null {
  return convert(amount, from, to, product ?? null);
}

// ─── Preferences ────────────────────────────────────────────────────────────

export async function rateMeal(ctx: HouseholdContext, mealId: string, rating: -1 | 0 | 1): Promise<void> {
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const visible = await loadPlannableMeals(tx, ctx.household.id, [mealId]);
    if (!visible.has(mealId)) throw notFound("That meal");
    await tx
      .insert(mealPreferences)
      .values({
        householdId: ctx.household.id,
        mealId,
        rating,
        timesRejected: rating === -1 ? 1 : 0,
        lastRejectedAt: rating === -1 ? now : null,
      })
      .onConflictDoUpdate({
        target: [mealPreferences.householdId, mealPreferences.mealId],
        set:
          rating === -1
            ? { rating, saved: false, timesRejected: sql`${mealPreferences.timesRejected} + 1`, lastRejectedAt: now }
            : { rating },
      });
  });
}

export async function setMealSaved(ctx: HouseholdContext, mealId: string, saved: boolean): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const visible = await loadPlannableMeals(tx, ctx.household.id, [mealId]);
    if (!visible.has(mealId)) throw notFound("That meal");
    await tx
      .insert(mealPreferences)
      .values({ householdId: ctx.household.id, mealId, saved, rating: saved ? 1 : 0 })
      .onConflictDoUpdate({
        target: [mealPreferences.householdId, mealPreferences.mealId],
        set: saved ? { saved, rating: sql`greatest(${mealPreferences.rating}, 0)` } : { saved },
      });
  });
}

/** Forget what Plenty learned about a meal (from the memory page). */
export async function clearMealPreference(ctx: HouseholdContext, mealId: string): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    await tx
      .delete(mealPreferences)
      .where(and(eq(mealPreferences.householdId, ctx.household.id), eq(mealPreferences.mealId, mealId)));
  });
}

// ─── Reading meals ──────────────────────────────────────────────────────────

export interface MealDetailView {
  meal: MealCardView;
  servings: number;
  ingredients: Array<{
    name: string;
    amount: string;
    status: IngredientAvailability["status"];
    substitute: boolean;
    usesSoonExpiring: boolean;
    optional: boolean;
    note: string | null;
    omitted: boolean;
  }>;
  steps: string[];
  timesCooked: number;
  lastCookedAt: string | null;
  editable: boolean;
  basedOnLibrary: boolean;
  blockedReason: string | null;
  plannedOn: Array<{ id: string; date: string; label: string }>;
}

export async function getMealDetail(ctx: HouseholdContext, mealId: string, servingsParam?: number, now = new Date()): Promise<MealDetailView | null> {
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const meal = loaded.planner.meals.find((m) => m.id === mealId);
    if (!meal) return null;
    const servings = servingsParam && servingsParam > 0 && servingsParam <= 24 ? servingsParam : loaded.servings;
    const availability = assessMealAvailability(meal, loaded.planner.lots, loaded.planner.products, { servings, date: loaded.today });
    const [row] = await tx.select().from(meals).where(eq(meals.id, mealId)).limit(1);
    const notes = await tx
      .select({ position: mealIngredients.position, note: mealIngredients.note, optional: mealIngredients.optional })
      .from(mealIngredients)
      .where(eq(mealIngredients.mealId, mealId))
      .orderBy(asc(mealIngredients.position));
    const omit = new Set(ingredientsToOmit(meal, loaded.planner.prefs).map((n: string) => normalizeText(n)));
    const allowed = isMealAllowed(meal, loaded.planner.prefs);
    const history = loaded.planner.history.get(meal.id);
    const plannedRows = await tx
      .select({ id: mealPlanItems.id, date: mealPlanItems.date })
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), eq(mealPlanItems.mealId, mealId), gte(mealPlanItems.date, loaded.today), eq(mealPlanItems.status, "planned")));
    const scale = servings / meal.servings;
    return {
      meal: toCard(meal, availability, history, null, row?.description ?? ""),
      servings,
      ingredients: meal.ingredients.map((ing, i) => {
        const a = availability[i];
        const qty = ing.quantity !== null ? ing.quantity * scale : null;
        return {
          name: ing.name,
          amount: qty !== null && ing.unit ? formatQuantity(qty, ing.unit) : qty !== null ? formatQuantity(qty, "each") : "",
          status: a?.status ?? "missing",
          substitute: a?.substitute ?? false,
          usesSoonExpiring: a?.usesSoonExpiring ?? false,
          optional: ing.optional,
          note: notes[i]?.note ?? null,
          omitted: omit.has(normalizeText(ing.name)),
        };
      }),
      steps: row?.steps ?? [],
      timesCooked: history?.timesCooked ?? 0,
      lastCookedAt: history?.lastCookedAt?.toISOString() ?? null,
      editable: true,
      basedOnLibrary: meal.source === "library",
      blockedReason: allowed.allowed ? null : allowed.reason,
      plannedOn: plannedRows.map((p) => ({ id: p.id, date: p.date, label: relativeDayLabel(p.date, loaded.today) })),
    };
  });
}

/** "What can I make right now?" — ranked by what's in the kitchen, what needs using, then preferences. */
export async function whatCanIMake(ctx: HouseholdContext, opts: { maxMinutes?: number } = {}, now = new Date()): Promise<MealCardView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const ranked = rankMealsForNow(loaded.planner, { limit: 18, maxMinutes: opts.maxMinutes, servings: loaded.servings });
    const desc = await descriptions(tx, ranked.map((r) => r.meal.id));
    return ranked.map((r) => toCard(r.meal, r.ingredients, loaded.planner.history.get(r.meal.id), r.primaryReason, desc.get(r.meal.id) ?? ""));
  });
}

export type RecipeFilter = "all" | "saved" | "favourites" | "quick" | "vegetarian" | "yours";

/** Browse the recipe collection with live availability. */
export async function browseMeals(ctx: HouseholdContext, filter: RecipeFilter = "all", now = new Date()): Promise<MealCardView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const desc = await descriptions(tx, loaded.planner.meals.map((m) => m.id));
    const cards = loaded.planner.meals
      .filter((m) => isMealAllowed(m, loaded.planner.prefs).allowed)
      .map((m) => {
        const avail = assessMealAvailability(m, loaded.planner.lots, loaded.planner.products, { servings: loaded.servings, date: loaded.today });
        return toCard(m, avail, loaded.planner.history.get(m.id), null, desc.get(m.id) ?? "");
      })
      .filter((c) => {
        if (filter === "saved") return c.saved;
        if (filter === "favourites") return c.rating === 1 || c.saved;
        if (filter === "quick") return c.timeMinutes <= 30;
        if (filter === "vegetarian") {
          const meal = loaded.planner.meals.find((m) => m.id === c.id)!;
          return !meal.contains.some((f) => ["meat", "pork", "poultry", "fish", "shellfish"].includes(f));
        }
        if (filter === "yours") return c.source !== "library";
        return c.rating !== -1;
      });
    cards.sort((a, b) => a.missingCount - b.missingCount || Number(b.saved) - Number(a.saved) || a.name.localeCompare(b.name));
    return cards;
  });
}

// ─── Editing recipes ────────────────────────────────────────────────────────

export interface EditMealInput {
  name: string;
  description: string;
  timeMinutes: number;
  servings: number;
  ingredients: Array<{ name: string; quantity: number | null; unit: Unit | null; optional: boolean }>;
  steps: string[];
}

function containsForIngredients(names: string[], productsList: Array<ProductInfo | null>): ContainsFlag[] {
  const flags = new Set<ContainsFlag>();
  for (const p of productsList) for (const f of p?.contains ?? []) flags.add(f);
  // Keyword safety net for ingredients we couldn't resolve to a product.
  const text = names.join(" ").toLowerCase();
  const KEYWORDS: Array<[RegExp, ContainsFlag]> = [
    [/peanut/, "peanuts"],
    [/\b(almond|cashew|walnut|pecan|pistachio|hazelnut|macadamia|pine nut)/, "tree_nuts"],
    [/\b(milk|cheese|butter|cream|yoghurt|yogurt|parmesan|feta|ricotta|mozzarella)\b/, "dairy"],
    [/\beggs?\b/, "egg"],
    [/\b(flour|bread|pasta|spaghetti|noodle|couscous|soy sauce|breadcrumb|tortilla|wrap)/, "gluten"],
    [/\b(soy|tofu|edamame|miso|tempeh)/, "soy"],
    [/\b(prawn|shrimp|crab|lobster|mussel|scallop|squid|calamari|oyster)/, "shellfish"],
    [/\b(fish|salmon|tuna|cod|snapper|barramundi|anchov|sardine|fish sauce)/, "fish"],
    [/\b(sesame|tahini)/, "sesame"],
    [/\b(chicken|turkey|duck)/, "poultry"],
    [/\b(bacon|ham|pork|prosciutto|chorizo|salami|pancetta)/, "pork"],
    [/\b(beef|lamb|mince|steak|veal|goat)/, "meat"],
    [/\b(wine|beer|sake|mirin|brandy|rum)\b/, "alcohol"],
    [/\bhoney\b/, "honey"],
  ];
  for (const [re, flag] of KEYWORDS) if (re.test(text)) flags.add(flag);
  return [...flags];
}

function validateRecipeShape(input: EditMealInput): void {
  if (!input.name.trim()) throw new AppError("validation", "Give the recipe a name.");
  if (input.ingredients.filter((i) => i.name.trim()).length < 1) throw new AppError("validation", "Add at least one ingredient.");
  if (input.steps.filter((s) => s.trim()).length < 1) throw new AppError("validation", "Add at least one step.");
  if (!(input.timeMinutes >= 1 && input.timeMinutes <= 600)) throw new AppError("validation", "Time should be between 1 and 600 minutes.");
  if (!(input.servings >= 1 && input.servings <= 24)) throw new AppError("validation", "Servings should be between 1 and 24.");
  for (const i of input.ingredients) {
    if (i.quantity !== null && !(i.quantity > 0)) throw new AppError("validation", `Check the amount for ${i.name}.`);
    if (i.unit !== null && !isUnit(i.unit)) throw new AppError("validation", `Check the unit for ${i.name}.`);
  }
}

async function insertHouseholdMeal(
  tx: Tx,
  ctx: HouseholdContext,
  base: { source: "ai" | "user"; cuisine: Cuisine; difficulty: Difficulty; mainIngredient: string; tags: string[]; basedOnMealId: string | null },
  input: EditMealInput,
): Promise<string> {
  const index = await loadProductIndex(tx, ctx.household.id);
  const ingredients = input.ingredients.filter((i) => i.name.trim());
  const resolved = ingredients.map((i) => resolveProduct(index, i.name, 0.72)?.product ?? null);
  const slug = `${base.source}-${normalizeText(input.name).replace(/\s+/g, "-").slice(0, 50)}-${Date.now().toString(36)}`;
  const [row] = await tx
    .insert(meals)
    .values({
      householdId: ctx.household.id,
      source: base.source,
      slug,
      name: input.name.trim().slice(0, 100),
      description: input.description.trim().slice(0, 300),
      cuisine: base.cuisine,
      timeMinutes: Math.round(input.timeMinutes),
      difficulty: base.difficulty,
      servings: Math.round(input.servings),
      mainIngredient: base.mainIngredient.slice(0, 40),
      tags: base.tags.slice(0, 10),
      contains: containsForIngredients(ingredients.map((i) => i.name), resolved),
      steps: input.steps.map((s) => s.trim()).filter(Boolean).slice(0, 20),
      basedOnMealId: base.basedOnMealId,
      createdBy: ctx.user.id,
    })
    .returning({ id: meals.id });
  await tx.insert(mealIngredients).values(
    ingredients.map((ing, position) => ({
      mealId: row.id,
      householdId: ctx.household.id,
      position,
      name: ing.name.trim().slice(0, 80),
      productId: resolved[position]?.id ?? null,
      quantity: ing.quantity,
      unit: ing.unit,
      optional: ing.optional,
    })),
  );
  return row.id;
}

/**
 * Edit a recipe. Library and AI recipes are copied into the household first
 * (so edits never change the shared library); future plans switch to the copy.
 */
export async function editMeal(ctx: HouseholdContext, mealId: string, input: EditMealInput): Promise<string> {
  validateRecipeShape(input);
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const [existing] = await tx
      .select()
      .from(meals)
      .where(and(eq(meals.id, mealId), or(isNull(meals.householdId), eq(meals.householdId, ctx.household.id)), isNull(meals.deletedAt)))
      .limit(1);
    if (!existing) throw notFound("That recipe");
    let targetId = existing.id;
    if (existing.householdId === null || existing.source !== "user") {
      targetId = await insertHouseholdMeal(
        tx,
        ctx,
        {
          source: "user",
          cuisine: existing.cuisine as Cuisine,
          difficulty: existing.difficulty,
          mainIngredient: existing.mainIngredient,
          tags: existing.tags,
          basedOnMealId: existing.id,
        },
        input,
      );
      const today = toDateString(now, ctx.household.timezone);
      await tx
        .update(mealPlanItems)
        .set({ mealId: targetId })
        .where(and(eq(mealPlanItems.householdId, ctx.household.id), eq(mealPlanItems.mealId, existing.id), gte(mealPlanItems.date, today), eq(mealPlanItems.status, "planned")));
      const [pref] = await tx
        .select()
        .from(mealPreferences)
        .where(and(eq(mealPreferences.householdId, ctx.household.id), eq(mealPreferences.mealId, existing.id)))
        .limit(1);
      await tx
        .insert(mealPreferences)
        .values({ householdId: ctx.household.id, mealId: targetId, rating: Math.max(0, pref?.rating ?? 0), saved: true })
        .onConflictDoNothing();
    } else {
      const index = await loadProductIndex(tx, ctx.household.id);
      const ingredients = input.ingredients.filter((i) => i.name.trim());
      const resolved = ingredients.map((i) => resolveProduct(index, i.name, 0.72)?.product ?? null);
      await tx
        .update(meals)
        .set({
          name: input.name.trim().slice(0, 100),
          description: input.description.trim().slice(0, 300),
          timeMinutes: Math.round(input.timeMinutes),
          servings: Math.round(input.servings),
          steps: input.steps.map((s) => s.trim()).filter(Boolean),
          contains: containsForIngredients(ingredients.map((i) => i.name), resolved),
        })
        .where(eq(meals.id, existing.id));
      await tx.delete(mealIngredients).where(eq(mealIngredients.mealId, existing.id));
      await tx.insert(mealIngredients).values(
        ingredients.map((ing, position) => ({
          mealId: existing.id,
          householdId: ctx.household.id,
          position,
          name: ing.name.trim(),
          productId: resolved[position]?.id ?? null,
          quantity: ing.quantity,
          unit: ing.unit,
          optional: ing.optional,
        })),
      );
    }
    await syncShoppingList(tx, ctx.household, now);
    return targetId;
  });
}

/** Remove a household's own recipe (library recipes can't be deleted, only disliked). */
export async function deleteHouseholdMeal(ctx: HouseholdContext, mealId: string): Promise<void> {
  await withUser(ctx.user.id, async (tx) => {
    const [existing] = await tx
      .select()
      .from(meals)
      .where(and(eq(meals.id, mealId), eq(meals.householdId, ctx.household.id)))
      .limit(1);
    if (!existing) throw new AppError("forbidden", "Only your own recipes can be deleted.");
    await tx.update(meals).set({ deletedAt: new Date() }).where(eq(meals.id, mealId));
  });
}

// ─── AI-written recipes ─────────────────────────────────────────────────────

function sanitizeGenerated(r: GeneratedRecipe): EditMealInput | null {
  const ingredients = r.ingredients
    .filter((i) => i.name.trim().length > 1)
    .map((i) => ({
      name: i.name.trim().slice(0, 80),
      quantity: i.quantity !== null && i.quantity > 0 && i.quantity < 100000 ? i.quantity : null,
      unit: i.unit,
      optional: i.optional,
    }));
  const steps = r.steps.map((s) => s.trim()).filter((s) => s.length > 3);
  if (ingredients.length < 3 || steps.length < 2) return null;
  if (!(r.timeMinutes >= 5 && r.timeMinutes <= 240) || !(r.servings >= 1 && r.servings <= 12)) return null;
  return { name: r.name.trim(), description: r.description.trim(), timeMinutes: r.timeMinutes, servings: r.servings, ingredients, steps };
}

/**
 * Ask the AI for fresh recipe ideas built around the current kitchen. Every
 * recipe is validated, resolved to real products and re-checked against
 * allergies and diets deterministically before it can be planned.
 */
export async function generateFreshIdeas(ctx: HouseholdContext): Promise<{ created: number; provider: string }> {
  await enforceRateLimit(`ai-recipes:${ctx.household.id}`, 6, 3600, "asking for new ideas");
  const now = new Date();
  const { loaded, input } = await withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const lots = loaded.planner.lots
      .filter((l) => l.remainingFraction > 0.1)
      .sort((a, b) => (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999"));
    const useSoon = lots.filter((l) => l.expiresOn && l.expiresOn <= addDays(loaded.today, 3)).map((l) => l.name);
    const avoid = [...loaded.planner.history.values()]
      .filter((h) => h.rating === -1 || h.timesRejected >= 2)
      .map((h) => loaded.planner.meals.find((m) => m.id === h.mealId)?.name)
      .filter((n): n is string => Boolean(n));
    return {
      loaded,
      input: {
        count: 3,
        servings: loaded.servings,
        maxMinutes: loaded.planner.prefs.weeknightMaxMinutes,
        inventory: lots.slice(0, 40).map((l) => ({ name: l.name, amount: formatQuantity(l.quantity * l.remainingFraction, l.unit), useBy: l.expiresOn })),
        useSoon,
        diets: loaded.planner.prefs.diets.map((d) => DIET_LABELS[d]),
        allergies: loaded.planner.prefs.allergies.map((a) => ALLERGEN_LABELS[a]),
        dislikes: loaded.planner.prefs.dislikedIngredients,
        favouriteCuisines: loaded.planner.prefs.favouriteCuisines.map((c) => CUISINE_LABELS[c]),
        avoidMeals: [...avoid, ...loaded.planner.meals.filter((m) => m.source !== "library").map((m) => m.name)],
      },
    };
  });
  const provider = getProvider(loaded.allowAi);
  if (!provider.generateRecipes) {
    throw new AppError(
      "ai_unavailable",
      loaded.allowAi
        ? "New recipe ideas need an AI key (ANTHROPIC_API_KEY). Plenty is using its built-in recipe collection instead."
        : "You've turned off AI processing in Privacy settings, so Plenty is using its built-in recipes.",
    );
  }
  let recipes: GeneratedRecipe[];
  try {
    recipes = await provider.generateRecipes(input);
  } catch (err) {
    if (err instanceof AIUnavailableError) throw new AppError("ai_unavailable", `Couldn't get new ideas right now — ${err.message.toLowerCase()} Try again in a minute.`);
    throw err;
  }
  return withUser(ctx.user.id, async (tx) => {
    let created = 0;
    for (const r of recipes) {
      const clean = sanitizeGenerated(r);
      if (!clean) continue;
      const id = await insertHouseholdMeal(
        tx,
        ctx,
        { source: "ai", cuisine: r.cuisine, difficulty: r.difficulty, mainIngredient: r.mainIngredient, tags: r.tags, basedOnMealId: null },
        clean,
      );
      // Deterministic safety check — never trust the model's own claims about allergens or diets.
      const stored = await loadPlannableMeals(tx, ctx.household.id, [id]);
      const meal = stored.get(id);
      if (!meal || !isMealAllowed(meal, loaded.planner.prefs).allowed) {
        await tx.delete(meals).where(eq(meals.id, id));
        continue;
      }
      created += 1;
    }
    return { created, provider: provider.label };
  });
}
