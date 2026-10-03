import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
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
import { ACCEPT_MATCH_SCORE, normalizeText } from "@/lib/normalize";
import { RECIPES, recipeContains } from "@/lib/recipes";
import { convert, formatQuantity, formatRecipeQuantity, isUnit, type Unit } from "@/lib/units";
import { AIUnavailableError, requireExternalProvider, type GeneratedRecipe } from "@/server/ai";
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
import { trackFor } from "@/server/analytics";
import { requireEntitlement } from "@/server/billing/limits";
import { requireCapability } from "@/server/permissions";
import { combinedFoodRules } from "./members";
import { notifyHousemates } from "./notifications";
import { inferContains, loadProductIndex, resolveProduct } from "./products";
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
  // The household's own settings plus everyone's personal food rules, combined without saying whose:
  // nobody has to share their allergies for meals to keep them in mind.
  const personal = await combinedFoodRules(tx, ctx.household.id);
  const union = <T extends string>(a: readonly T[], b: readonly string[]): T[] => [...new Set<string>([...a, ...b])] as T[];
  const plannerPrefs: PlannerPreferences = {
    diets: union((prefs?.diets ?? []) as Diet[], personal.diets),
    allergies: union((prefs?.allergies ?? []) as Allergen[], personal.allergies),
    dislikedIngredients: union(prefs?.dislikedIngredients ?? [], personal.dislikedIngredients),
    favouriteCuisines: (prefs?.favouriteCuisines ?? []) as Cuisine[],
    weeknightMaxMinutes: prefs?.weeknightMaxMinutes ?? null,
    householdSize: householdSizeOf(ctx.household),
    weeklyBudget: prefs?.weeklyBudget ?? null,
  };
  const today = toDateString(now, ctx.household.timezone);
  return {
    planner: {
      meals: [...mealMap.values()],
      lots: lotsFromLive(state, today),
      products: state.index.byId,
      prefs: plannerPrefs,
      history,
      today,
      now,
    },
    live: state,
    today,
    servings: defaultServings(ctx.household),
    // Home-cooked dinners a week: how often they cook, minus their usual takeaway nights.
    nightsPerWeek: Math.max(
      1,
      Math.min(
        COOKING_FREQUENCY_NIGHTS[(prefs?.cookingFrequency as CookingFrequency | null) ?? "most_nights"],
        7 - (prefs?.takeawayPerWeek ?? 0),
      ),
    ),
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

/** The coming week of dinners with live ingredient availability. Pass `live` to reuse a kitchen state already computed for this request. */
export async function getMealPlan(ctx: HouseholdContext, now = new Date(), live?: LiveState): Promise<MealPlanView> {
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now, live);
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
): Promise<PlanResult> {
  requireCapability(ctx, "plan_meals");
  // Planning tonight or tomorrow is for everyone; weekly plans and regenerating are part of the paid plans.
  if (range === "3days" || range === "week" || opts.regenerate) requireEntitlement(ctx, "advanced_meal_planning", "Weekly meal plans");
  const result = await planDinners(ctx, (today, nightsPerWeek) => planDates(range, today, nightsPerWeek), { regenerate: opts.regenerate, range });
  if (result.planned > 0) await trackFor(ctx, "meal_suggested", { surface: "plan" });
  return result;
}

/** Plan one specific night (from an empty day on the plan), whatever the usual takeaway nights are. */
export async function planDinnerOn(ctx: HouseholdContext, date: string): Promise<PlanResult> {
  requireCapability(ctx, "plan_meals");
  return planDinners(ctx, (today) => {
    if (date < today || date > addDays(today, 6)) throw new AppError("validation", "Pick a day in the coming week.");
    return [date];
  });
}

export interface PlanResult {
  planned: number;
  /** Nights asked for that nothing suitable could fill (or, when regenerating, that kept their meal). */
  unfilled: number;
}

async function planDinners(
  ctx: HouseholdContext,
  pickDates: (today: string, nightsPerWeek: number) => string[],
  opts: { regenerate?: boolean; range?: PlanRange } = {},
): Promise<PlanResult> {
  const now = new Date();
  const { range } = opts;
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const dates = pickDates(loaded.today, loaded.nightsPerWeek);
    const planId = await activePlanId(tx, ctx.household.id, loaded.today, ctx.user.id);
    const existing = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), gte(mealPlanItems.date, loaded.today), eq(mealPlanItems.slot, "dinner")));

    // A planned dinner whose recipe has since been deleted is an empty night.
    const mealsById = new Map(loaded.planner.meals.map((m) => [m.id, m]));
    const known = new Set(mealsById.keys());
    const orphaned = (e: DbMealPlanItem) => e.status === "planned" && !known.has(e.mealId);
    // Allergies and diets are hard rules: a planned dinner that no longer fits them (say an
    // allergy was added since) is replaced rather than kept.
    const noLongerAllowed = (e: DbMealPlanItem) =>
      e.status === "planned" && known.has(e.mealId) && !isMealAllowed(mealsById.get(e.mealId)!, loaded.planner.prefs, loaded.planner.products).allowed;
    const targetDates = new Set(dates);
    const replaceable = existing.filter(
      (e) => targetDates.has(e.date) && e.status === "planned" && (opts.regenerate || orphaned(e) || noLongerAllowed(e)),
    );
    const keep = existing.filter((e) => e.status !== "skipped" && !orphaned(e) && !replaceable.some((r) => r.id === e.id));
    const openDates = dates.filter((d) => !keep.some((k) => k.date === d));
    if (openDates.length === 0) return { planned: 0, unfilled: 0 };

    // The planner only honours kept meals on dates it's planning, so hand it the planned nights
    // too: variety and ingredient allocation then account for them. Cooked dinners have already
    // used their ingredients, so they only count for variety. Only open nights are written.
    const open = new Set(openDates);
    const plannerKeep = keep.filter((k) => k.status === "planned" && known.has(k.mealId)).map((k) => ({ date: k.date, mealId: k.mealId }));
    const alreadyCooked = keep.filter((k) => k.status === "cooked").map((k) => k.mealId);
    const picks = generatePlan(loaded.planner, {
      dates: [...new Set([...openDates, ...plannerKeep.map((k) => k.date)])],
      servings: loaded.servings,
      keep: plannerKeep,
      exclude: [...replaceable.map((r) => r.mealId), ...alreadyCooked],
      seed: seedFrom(now),
    }).filter((p) => open.has(p.date));
    if (picks.length === 0) {
      throw new AppError(
        "not_found",
        opts.regenerate
          ? "Plenty couldn't find anything different that fits your preferences, so your plan is unchanged."
          : "Plenty couldn't find meals that fit your preferences. Try relaxing a dislike or allergy filter.",
      );
    }
    // Only replace a night that got a new meal; a night nothing else fits keeps what it had.
    const pickedDates = new Set(picks.map((p) => p.date));
    for (const r of replaceable) {
      if (pickedDates.has(r.date) || orphaned(r)) await tx.delete(mealPlanItems).where(eq(mealPlanItems.id, r.id));
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
    return { planned: picks.length, unfilled: openDates.length - picks.length };
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
  requireCapability(ctx, "plan_meals");
  // "Don't suggest this again" is a preference, free for everyone; a plain swap is part of the paid plans.
  if (!opts.dislike) requireEntitlement(ctx, "advanced_meal_planning", "Swapping meals");
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
    const known = new Set(loaded.planner.meals.map((m) => m.id));
    const others = (
      await tx
        .select({ date: mealPlanItems.date, mealId: mealPlanItems.mealId, status: mealPlanItems.status })
        .from(mealPlanItems)
        .where(and(eq(mealPlanItems.householdId, ctx.household.id), gte(mealPlanItems.date, loaded.today), sql`${mealPlanItems.id} <> ${itemId}`))
    )
      .filter((o) => o.status !== "skipped" && o.date !== item.date && known.has(o.mealId));
    // The planner only honours kept meals on dates it's planning: include the rest of the plan
    // so the swap can't repeat one of them or count their ingredients as free. Cooked dinners
    // have already used their ingredients, so they only rule out repeats.
    const plannedOthers = others.filter((o) => o.status === "planned").map((o) => ({ date: o.date, mealId: o.mealId }));
    const pick = generatePlan(loaded.planner, {
      dates: [item.date, ...plannedOthers.map((o) => o.date)],
      servings: item.servings,
      keep: plannedOthers,
      exclude: [item.mealId, ...others.filter((o) => o.status === "cooked").map((o) => o.mealId)],
      seed: seedFrom(now),
    }).find((p) => p.date === item.date);
    if (!pick) throw new AppError("not_found", "There's nothing else that fits right now. Try adjusting your preferences.");
    await tx.update(mealPlanItems).set({ mealId: pick.mealId, reason: pick.reason }).where(eq(mealPlanItems.id, itemId));
    await bumpPreference(tx, ctx.household.id, pick.mealId, "planned", now);
    await syncShoppingList(tx, ctx.household, now, loaded.live);
    return { mealName: loaded.planner.meals.find((m) => m.id === pick.mealId)?.name ?? "a new meal" };
  });
}

export async function removePlanItem(ctx: HouseholdContext, itemId: string): Promise<void> {
  requireCapability(ctx, "plan_meals");
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadPlanItem(tx, ctx.household.id, itemId);
    await tx.delete(mealPlanItems).where(eq(mealPlanItems.id, item.id));
    await syncShoppingList(tx, ctx.household, now);
  });
}

export async function setPlanItemServings(ctx: HouseholdContext, itemId: string, servings: number): Promise<void> {
  requireCapability(ctx, "plan_meals");
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
  requireCapability(ctx, "plan_meals");
  const now = new Date();
  await withUser(ctx.user.id, async (tx) => {
    const item = await loadPlanItem(tx, ctx.household.id, itemId);
    const today = toDateString(now, ctx.household.timezone);
    if (date < today || date > addDays(today, 13)) throw new AppError("validation", "Pick a day in the next two weeks.");
    // A cooked dinner is a record of what happened that night; it doesn't move.
    if (item.status === "cooked") throw new AppError("conflict", "That meal has already been cooked.");
    const [other] = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), eq(mealPlanItems.date, date), eq(mealPlanItems.slot, item.slot)))
      .limit(1);
    if (other && other.id !== item.id && other.status === "cooked") {
      throw new AppError("conflict", "Dinner that night has already been cooked. Pick another day.");
    }
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

/**
 * Put a meal on a night. A dinner already planned that night is replaced (and
 * its name returned so the person is told); a cooked one is never overwritten.
 */
export async function addMealToPlan(ctx: HouseholdContext, mealId: string, date: string): Promise<{ replaced: string | null }> {
  requireCapability(ctx, "plan_meals");
  const now = new Date();
  const result = await withUser(ctx.user.id, async (tx) => {
    const today = toDateString(now, ctx.household.timezone);
    if (date < today || date > addDays(today, 13)) throw new AppError("validation", "Pick a day in the next two weeks.");
    const visible = await loadPlannableMeals(tx, ctx.household.id, [mealId]);
    if (!visible.has(mealId)) throw notFound("That meal");
    const [current] = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), eq(mealPlanItems.date, date), eq(mealPlanItems.slot, "dinner")))
      .limit(1)
      .for("update");
    if (current?.status === "cooked") {
      throw new AppError("conflict", "Dinner that night has already been cooked. Pick another day.");
    }
    let replaced: string | null = null;
    const planId = await activePlanId(tx, ctx.household.id, today, ctx.user.id);
    if (current) {
      if (current.status === "planned" && current.mealId !== mealId) {
        const [old] = await tx.select({ name: meals.name, deletedAt: meals.deletedAt }).from(meals).where(eq(meals.id, current.mealId)).limit(1);
        replaced = old && !old.deletedAt ? old.name : null;
      }
      await tx
        .update(mealPlanItems)
        .set({ mealId, reason: "You picked this one", status: "planned", cookedAt: null })
        .where(eq(mealPlanItems.id, current.id));
    } else {
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
          setWhere: sql`${mealPlanItems.status} <> 'cooked'`,
        });
    }
    await tx
      .update(mealPlans)
      .set({ endDate: sql`greatest(${mealPlans.endDate}, ${date}::date)` })
      .where(eq(mealPlans.id, planId));
    await bumpPreference(tx, ctx.household.id, mealId, "planned", now);
    await syncShoppingList(tx, ctx.household, now);
    return { replaced };
  });
  await trackFor(ctx, "meal_selected", { surface: "plan" });
  return result;
}

/**
 * "We cooked it": deduct the ingredients the meal used from the kitchen, so
 * nobody has to update quantities by hand, and remember the household made it.
 */
export async function markPlanItemCooked(ctx: HouseholdContext, itemId: string): Promise<{ usedItems: number }> {
  requireCapability(ctx, "plan_meals");
  const now = new Date();
  const result = await withUser(ctx.user.id, async (tx) => {
    const item = await loadPlanItem(tx, ctx.household.id, itemId);
    if (item.status === "cooked") return { usedItems: 0 };
    // Claim it before touching the kitchen: a second tap (or a housemate on another phone)
    // waits here, then finds it already cooked instead of deducting everything twice.
    if (!(await claimCooked(tx, item.id, now))) return { usedItems: 0 };
    const loaded = await loadContext(tx, ctx, now);
    const meal = loaded.planner.meals.find((m) => m.id === item.mealId);
    if (!meal) throw notFound("That meal");
    const usage = allocationFor(meal, loaded, item.servings, loaded.today);
    const touched = await consumeForMealTx(tx, ctx.household, ctx.user.id, usage, item.id, now);
    await bumpPreference(tx, ctx.household.id, item.mealId, "cooked", now);
    await refreshLearning(tx, ctx.household, touched, now);
    await syncShoppingList(tx, ctx.household, now);
    return { usedItems: usage.length };
  });
  if (result.usedItems > 0) await trackFor(ctx, "meal_selected", { surface: "plan" });
  return result;
}

/** Cook something off-plan (from "What can I make?" or a recipe page). */
export async function cookMealNow(ctx: HouseholdContext, mealId: string, servings?: number): Promise<{ usedItems: number }> {
  requireCapability(ctx, "plan_meals");
  const now = new Date();
  const result = await withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const meal = loaded.planner.meals.find((m) => m.id === mealId);
    if (!meal) throw notFound("That meal");
    const todays = await tx
      .select()
      .from(mealPlanItems)
      .where(and(eq(mealPlanItems.householdId, ctx.household.id), eq(mealPlanItems.date, loaded.today), eq(mealPlanItems.mealId, mealId)));
    // Tonight's plan has this meal: cook that (claimed first, so it can't be cooked twice).
    const open = todays.find((r) => r.status !== "cooked");
    const planItemId = open && (await claimCooked(tx, open.id, now)) ? open.id : null;
    if (!planItemId && todays.length > 0) {
      throw new AppError("conflict", `${meal.name} is already marked as cooked today, so Plenty has taken its ingredients out of your kitchen.`);
    }
    const usage = allocationFor(meal, loaded, servings ?? loaded.servings, loaded.today);
    const touched = await consumeForMealTx(tx, ctx.household, ctx.user.id, usage, planItemId, now);
    await bumpPreference(tx, ctx.household.id, mealId, "cooked", now);
    await refreshLearning(tx, ctx.household, touched, now);
    await syncShoppingList(tx, ctx.household, now);
    return { usedItems: usage.length };
  });
  await trackFor(ctx, "meal_selected", { surface: "cook_now" });
  return result;
}

/** Mark a plan item cooked unless it already is. False when someone else got there first. */
async function claimCooked(tx: Tx, itemId: string, now: Date): Promise<boolean> {
  const claimed = await tx
    .update(mealPlanItems)
    .set({ status: "cooked", cookedAt: now })
    .where(and(eq(mealPlanItems.id, itemId), ne(mealPlanItems.status, "cooked")))
    .returning({ id: mealPlanItems.id });
  return claimed.length > 0;
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

/** When a meal stops being disliked, take back the one rejection the dislike added. */
function undoDislike() {
  return {
    timesRejected: sql<number>`greatest(0, ${mealPreferences.timesRejected} - case when ${mealPreferences.rating} = -1 then 1 else 0 end)`,
    lastRejectedAt: sql<Date | null>`case when ${mealPreferences.rating} = -1 and ${mealPreferences.timesRejected} <= 1 then null else ${mealPreferences.lastRejectedAt} end`,
  };
}

export async function rateMeal(ctx: HouseholdContext, mealId: string, rating: -1 | 0 | 1): Promise<void> {
  requireCapability(ctx, "plan_meals");
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
        // A dislike counts as one rejection, once: tapping it again doesn't add more, and
        // undoing it takes that rejection back so an accidental tap isn't held against the meal.
        set:
          rating === -1
            ? {
                rating,
                saved: false,
                timesRejected: sql`${mealPreferences.timesRejected} + case when ${mealPreferences.rating} = -1 then 0 else 1 end`,
                lastRejectedAt: sql`case when ${mealPreferences.rating} = -1 then ${mealPreferences.lastRejectedAt} else ${now.toISOString()}::timestamptz end`,
              }
            : { rating, ...undoDislike() },
      });
  });
}

export async function setMealSaved(ctx: HouseholdContext, mealId: string, saved: boolean): Promise<void> {
  requireCapability(ctx, "plan_meals");
  await withUser(ctx.user.id, async (tx) => {
    const visible = await loadPlannableMeals(tx, ctx.household.id, [mealId]);
    if (!visible.has(mealId)) throw notFound("That meal");
    await tx
      .insert(mealPreferences)
      // Saving is a bookmark, not a like (the planner already rewards saved meals): it clears a
      // dislike but never sets the rating, whether or not Plenty has seen the meal before.
      .values({ householdId: ctx.household.id, mealId, saved, rating: 0 })
      .onConflictDoUpdate({
        target: [mealPreferences.householdId, mealPreferences.mealId],
        set: saved ? { saved, rating: sql`greatest(${mealPreferences.rating}, 0)`, ...undoDislike() } : { saved },
      });
  });
}

/** Forget what Plenty learned about a meal (from the memory page). */
export async function clearMealPreference(ctx: HouseholdContext, mealId: string): Promise<void> {
  requireCapability(ctx, "plan_meals");
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
    const omit = new Set(ingredientsToOmit(meal, loaded.planner.prefs, loaded.planner.products).map((o) => normalizeText(o.name)));
    const allowed = isMealAllowed(meal, loaded.planner.prefs, loaded.planner.products);
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
          amount: qty !== null ? formatRecipeQuantity(qty, ing.unit ?? "each") : "",
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
  const result = await withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const ranked = rankMealsForNow(loaded.planner, { limit: 18, maxMinutes: opts.maxMinutes, servings: loaded.servings });
    const desc = await descriptions(tx, ranked.map((r) => r.meal.id));
    return ranked.map((r) => toCard(r.meal, r.ingredients, loaded.planner.history.get(r.meal.id), r.primaryReason, desc.get(r.meal.id) ?? ""));
  });
  await trackFor(ctx, "meal_suggested", { surface: "cook_now" });
  return result;
}

export type RecipeFilter = "all" | "saved" | "favourites" | "quick" | "vegetarian" | "yours";

/** Browse the recipe collection with live availability. */
export async function browseMeals(ctx: HouseholdContext, filter: RecipeFilter = "all", now = new Date()): Promise<MealCardView[]> {
  return withUser(ctx.user.id, async (tx) => {
    const loaded = await loadContext(tx, ctx, now);
    const desc = await descriptions(tx, loaded.planner.meals.map((m) => m.id));
    const cards = loaded.planner.meals
      .filter((m) => isMealAllowed(m, loaded.planner.prefs, loaded.planner.products).allowed)
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
  // Safety net from the wording itself, for ingredients we couldn't resolve to a product.
  names.forEach((name, i) => {
    if (!productsList[i]) for (const f of inferContains(name)) flags.add(f);
  });
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
  const resolved = ingredients.map((i) => resolveProduct(index, i.name, ACCEPT_MATCH_SCORE)?.product ?? null);
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
  requireCapability(ctx, "plan_meals");
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
      const resolved = ingredients.map((i) => resolveProduct(index, i.name, ACCEPT_MATCH_SCORE)?.product ?? null);
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

/**
 * Remove a household's own recipe (library recipes can't be deleted, only
 * disliked). Upcoming dinners that used it come off the plan — a night with a
 * recipe nobody can open would otherwise look empty but block planning.
 */
export async function deleteHouseholdMeal(ctx: HouseholdContext, mealId: string): Promise<{ unplanned: number }> {
  requireCapability(ctx, "plan_meals");
  const now = new Date();
  return withUser(ctx.user.id, async (tx) => {
    const [existing] = await tx
      .select()
      .from(meals)
      .where(and(eq(meals.id, mealId), eq(meals.householdId, ctx.household.id)))
      .limit(1);
    if (!existing) throw new AppError("forbidden", "Only your own recipes can be deleted.");
    await tx.update(meals).set({ deletedAt: now }).where(eq(meals.id, mealId));
    const today = toDateString(now, ctx.household.timezone);
    const unplanned = await tx
      .delete(mealPlanItems)
      .where(
        and(
          eq(mealPlanItems.householdId, ctx.household.id),
          eq(mealPlanItems.mealId, mealId),
          gte(mealPlanItems.date, today),
          eq(mealPlanItems.status, "planned"),
        ),
      )
      .returning({ id: mealPlanItems.id });
    if (unplanned.length > 0) await syncShoppingList(tx, ctx.household, now);
    return { unplanned: unplanned.length };
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
  requireCapability(ctx, "plan_meals");
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
  // New recipe ideas have no on-device equivalent, so this never falls back to sending: without the household's
  // permission, the plan and a configured service it stops here with a message that says what to do.
  const { provider } = await requireExternalProvider(ctx.household.id, "recipes");
  if (!provider.generateRecipes) {
    throw new AppError("ai_unavailable", "New recipe ideas aren't available right now. Plenty is using its built-in recipe collection instead.");
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
      if (!meal || !isMealAllowed(meal, loaded.planner.prefs, loaded.planner.products).allowed) {
        await tx.delete(meals).where(eq(meals.id, id));
        continue;
      }
      created += 1;
    }
    return { created, provider: provider.label };
  });
}
