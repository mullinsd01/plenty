import "server-only";
import { eq } from "drizzle-orm";
import type { HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import {
  consumptionEvents,
  consumptionStats,
  households,
  inventoryEvents,
  inventoryItems,
  mealIngredients,
  mealPlanItems,
  mealPreferences,
  meals,
  preferences,
  receiptItems,
  receipts,
  shoppingListItems,
} from "@/server/db/schema";
import { listMembers } from "./household";

/**
 * A complete, human-readable export of the household's data. Everything is
 * read through the member's row-level-security context.
 */
export async function exportHouseholdData(ctx: HouseholdContext) {
  const members = await listMembers(ctx);
  return withUser(ctx.user.id, async (tx) => {
    const hid = ctx.household.id;
    const [household] = await tx.select().from(households).where(eq(households.id, hid));
    const [prefs] = await tx.select().from(preferences).where(eq(preferences.householdId, hid));
    const householdMeals = await tx.select().from(meals).where(eq(meals.householdId, hid));
    const householdIngredients = await tx.select().from(mealIngredients).where(eq(mealIngredients.householdId, hid));
    return {
      exportedAt: new Date().toISOString(),
      format: "plenty-export/1",
      household,
      members: members.map((m) => ({ name: m.displayName, email: m.email, role: m.role, joinedAt: m.joinedAt })),
      preferences: prefs ?? null,
      inventory: await tx.select().from(inventoryItems).where(eq(inventoryItems.householdId, hid)),
      inventoryEvents: await tx.select().from(inventoryEvents).where(eq(inventoryEvents.householdId, hid)),
      consumption: await tx.select().from(consumptionEvents).where(eq(consumptionEvents.householdId, hid)),
      learnedStats: await tx.select().from(consumptionStats).where(eq(consumptionStats.householdId, hid)),
      receipts: await tx.select().from(receipts).where(eq(receipts.householdId, hid)),
      receiptItems: await tx.select().from(receiptItems).where(eq(receiptItems.householdId, hid)),
      mealPlan: await tx.select().from(mealPlanItems).where(eq(mealPlanItems.householdId, hid)),
      mealPreferences: await tx.select().from(mealPreferences).where(eq(mealPreferences.householdId, hid)),
      recipes: householdMeals.map((m) => ({ ...m, ingredients: householdIngredients.filter((i) => i.mealId === m.id) })),
      shoppingList: await tx.select().from(shoppingListItems).where(eq(shoppingListItems.householdId, hid)),
    };
  });
}
