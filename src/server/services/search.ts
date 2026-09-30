import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { STORAGE_LOCATION_LABELS, CUISINE_LABELS, type Cuisine, type StorageLocation } from "@/lib/domain";
import { formatQuantity, type Unit } from "@/lib/units";
import type { SearchResults } from "@/features/search/types";
import type { HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { inventoryItems, mealIngredients, meals, shoppingListItems, shoppingLists } from "@/server/db/schema";

const LIMIT = 6;

/**
 * Forgiving search across the kitchen, the shopping list and meals.
 * Uses trigram word-similarity (typos, partial words) plus substring matches;
 * meals also match on their ingredients ("spinach" finds spinach dishes).
 */
export async function search(ctx: HouseholdContext, rawQuery: string): Promise<SearchResults> {
  const q = rawQuery.trim().slice(0, 60);
  if (!q) return { inventory: [], shopping: [], meals: [] };
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  return withUser(ctx.user.id, async (tx) => {
    const itemScore = sql<number>`greatest(word_similarity(${q}, ${inventoryItems.name}), case when ${inventoryItems.name} ilike ${like} then 1 else 0 end)`;
    const inv = await tx
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        location: inventoryItems.location,
        quantity: inventoryItems.quantity,
        unit: inventoryItems.unit,
        score: itemScore,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.householdId, ctx.household.id),
          eq(inventoryItems.status, "active"),
          isNull(inventoryItems.deletedAt),
          sql`${itemScore} > 0.35`,
        ),
      )
      .orderBy(sql`${itemScore} desc`)
      .limit(LIMIT);

    const listScore = sql<number>`greatest(word_similarity(${q}, ${shoppingListItems.name}), case when ${shoppingListItems.name} ilike ${like} then 1 else 0 end)`;
    const shop = await tx
      .select({ id: shoppingListItems.id, name: shoppingListItems.name, reason: shoppingListItems.reason, checkedAt: shoppingListItems.checkedAt })
      .from(shoppingListItems)
      .innerJoin(shoppingLists, eq(shoppingLists.id, shoppingListItems.listId))
      .where(
        and(
          eq(shoppingListItems.householdId, ctx.household.id),
          eq(shoppingLists.status, "active"),
          isNull(shoppingListItems.purchasedAt),
          sql`(${shoppingListItems.dismissedUntil} is null or ${shoppingListItems.dismissedUntil} <= now())`,
          sql`${listScore} > 0.35`,
        ),
      )
      .orderBy(sql`${listScore} desc`)
      .limit(LIMIT);

    const mealScore = sql<number>`greatest(
      word_similarity(${q}, ${meals.name}),
      case when ${meals.name} ilike ${like} then 1 else 0 end,
      case when ${meals.cuisine} ilike ${like} then 0.8 else 0 end,
      case when exists (select 1 from ${mealIngredients} mi where mi.meal_id = ${meals.id} and mi.name ilike ${like}) then 0.7 else 0 end
    )`;
    const mealRows = await tx
      .select({ id: meals.id, name: meals.name, cuisine: meals.cuisine, timeMinutes: meals.timeMinutes, score: mealScore })
      .from(meals)
      .where(
        and(
          or(isNull(meals.householdId), eq(meals.householdId, ctx.household.id)),
          isNull(meals.deletedAt),
          sql`${mealScore} > 0.4`,
        ),
      )
      .orderBy(sql`${mealScore} desc`, meals.name)
      .limit(LIMIT + 2);

    return {
      inventory: inv.map((i) => ({
        id: i.id,
        title: i.name,
        detail: `${formatQuantity(i.quantity, i.unit as Unit)} · ${STORAGE_LOCATION_LABELS[i.location as StorageLocation]}`,
        href: `/kitchen/${i.id}`,
      })),
      shopping: shop.map((s) => ({
        id: s.id,
        title: s.name,
        detail: s.checkedAt ? "In your trolley" : s.reason,
        href: "/list",
      })),
      meals: mealRows.map((m) => ({
        id: m.id,
        title: m.name,
        detail: `${CUISINE_LABELS[m.cuisine as Cuisine] ?? "Recipe"} · ${m.timeMinutes} min`,
        href: `/meals/recipes/${m.id}`,
      })),
    };
  });
}
