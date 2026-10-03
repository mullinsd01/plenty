import "server-only";
import { and, asc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { ContainsFlag, Cuisine, Difficulty, StorageLocation } from "@/lib/domain";
import type { InventoryLot, PlannableMeal } from "@/lib/meals/types";
import { learningKey } from "@/lib/members/scope";
import type { Unit } from "@/lib/units";
import type { Queryable } from "@/server/db/client";
import { mealIngredients, mealPlanItems, meals, type DbMeal } from "@/server/db/schema";
import { dailyRateFor, itemBaseAmount, itemScope, type LiveState } from "./learning";

function toPlannable(meal: DbMeal, ingredients: Array<typeof mealIngredients.$inferSelect>): PlannableMeal {
  return {
    id: meal.id,
    slug: meal.slug,
    name: meal.name,
    cuisine: meal.cuisine as Cuisine,
    timeMinutes: meal.timeMinutes,
    difficulty: meal.difficulty as Difficulty,
    servings: meal.servings,
    mainIngredient: meal.mainIngredient,
    tags: meal.tags,
    contains: meal.contains as ContainsFlag[],
    source: meal.source,
    ingredients: ingredients
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        name: i.name,
        productId: i.productId,
        quantity: i.quantity,
        unit: (i.unit as Unit | null) ?? null,
        optional: i.optional,
      })),
  };
}

/** Load meals visible to the household (library + its own), with ingredients. */
export async function loadPlannableMeals(
  db: Queryable,
  householdId: string,
  ids?: string[],
): Promise<Map<string, PlannableMeal>> {
  if (ids && ids.length === 0) return new Map();
  const visible = and(
    or(isNull(meals.householdId), eq(meals.householdId, householdId)),
    isNull(meals.deletedAt),
    ids ? inArray(meals.id, ids) : undefined,
  );
  const mealRows = await db.select().from(meals).where(visible);
  if (mealRows.length === 0) return new Map();
  const ingredientRows = await db
    .select()
    .from(mealIngredients)
    .where(inArray(mealIngredients.mealId, mealRows.map((m) => m.id)));
  const byMeal = new Map<string, Array<typeof mealIngredients.$inferSelect>>();
  for (const row of ingredientRows) {
    const list = byMeal.get(row.mealId) ?? [];
    list.push(row);
    byMeal.set(row.mealId, list);
  }
  return new Map(mealRows.map((m) => [m.id, toPlannable(m, byMeal.get(m.id) ?? [])]));
}

/**
 * The kitchen as the meal and shopping engines see it. The batch of each
 * product that's currently being used carries the everyday pace of whoever
 * it belongs to, so meals later in the week don't count milk or bread that
 * will have gone into lunches by then.
 *
 * Meals are planned for the household, so a person's private items are left
 * out: the plan is shared, and it shouldn't be shaped by (or reveal) food
 * only one person can see. Items that belong to someone but are shared with
 * the household still count.
 */
export function lotsFromLive(live: LiveState, today: string): InventoryLot[] {
  const shared = live.activeItems.filter((item) => item.visibility !== "private");
  const inUse = new Set<string>();
  const seen = new Set<string>();
  for (const item of shared) {
    if (!item.productId) continue;
    const key = learningKey(item.productId, itemScope(live, item));
    if (seen.has(key)) continue;
    if ((live.itemFractions.get(item.id) ?? item.remainingFraction) <= 0.02) continue;
    seen.add(key);
    inUse.add(item.id);
  }
  return shared.map((item) => {
    const product = item.productId ? live.index.byId.get(item.productId) ?? null : null;
    const rate = dailyRateFor(live, item);
    const base = product ? itemBaseAmount(item, product) : null;
    const dailyUseFraction = inUse.has(item.id) && rate && base && base.amount > 0 ? rate / base.amount : 0;
    return {
      id: item.id,
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit as Unit,
      remainingFraction: live.itemFractions.get(item.id) ?? item.remainingFraction,
      expiresOn: item.actualExpiry ?? item.estimatedExpiry,
      location: item.location as StorageLocation,
      dailyUseFraction,
      levelAsOf: today,
    };
  });
}

/** Upcoming planned meals (today onwards), in date order. */
export async function upcomingPlanItems(db: Queryable, householdId: string, today: string) {
  return db
    .select()
    .from(mealPlanItems)
    .where(and(eq(mealPlanItems.householdId, householdId), gte(mealPlanItems.date, today), eq(mealPlanItems.status, "planned")))
    .orderBy(asc(mealPlanItems.date), asc(mealPlanItems.slot));
}
