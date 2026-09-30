import "server-only";
import { and, asc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { ContainsFlag, Cuisine, Difficulty, StorageLocation } from "@/lib/domain";
import type { InventoryLot, PlannableMeal } from "@/lib/meals/types";
import type { Unit } from "@/lib/units";
import type { Queryable } from "@/server/db/client";
import { mealIngredients, mealPlanItems, meals, type DbMeal } from "@/server/db/schema";
import type { LiveState } from "./learning";

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

/** Current kitchen as lots for the meal and shopping engines (using estimated levels). */
export function lotsFromLive(live: LiveState): InventoryLot[] {
  return live.activeItems.map((item) => ({
    id: item.id,
    productId: item.productId,
    name: item.name,
    quantity: item.quantity,
    unit: item.unit as Unit,
    remainingFraction: live.itemFractions.get(item.id) ?? item.remainingFraction,
    expiresOn: item.actualExpiry ?? item.estimatedExpiry,
    location: item.location as StorageLocation,
  }));
}

/** Upcoming planned meals (today onwards), in date order. */
export async function upcomingPlanItems(db: Queryable, householdId: string, today: string) {
  return db
    .select()
    .from(mealPlanItems)
    .where(and(eq(mealPlanItems.householdId, householdId), gte(mealPlanItems.date, today), eq(mealPlanItems.status, "planned")))
    .orderBy(asc(mealPlanItems.date), asc(mealPlanItems.slot));
}
