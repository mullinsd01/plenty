import "server-only";
import { and, eq } from "drizzle-orm";
import type { HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import {
  consumptionEvents,
  consumptionStats,
  householdInvitations,
  households,
  inventoryEvents,
  inventoryItems,
  mealIngredients,
  mealPlanItems,
  mealPlans,
  mealPreferences,
  meals,
  notifications,
  notificationSettings,
  predictions,
  preferences,
  productAliases,
  products,
  receiptItems,
  receipts,
  shoppingListItemSources,
  shoppingListItems,
  shoppingLists,
} from "@/server/db/schema";
import { listMembers } from "./members";

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
      members: members.map((m) => ({ name: m.name, email: m.email, role: m.role, hasAccount: m.hasAccount, joinedAt: m.joinedAt })),
      preferences: prefs ?? null,
      inventory: await tx.select().from(inventoryItems).where(eq(inventoryItems.householdId, hid)),
      inventoryEvents: await tx.select().from(inventoryEvents).where(eq(inventoryEvents.householdId, hid)),
      consumption: await tx.select().from(consumptionEvents).where(eq(consumptionEvents.householdId, hid)),
      learnedStats: await tx.select().from(consumptionStats).where(eq(consumptionStats.householdId, hid)),
      receipts: await tx.select().from(receipts).where(eq(receipts.householdId, hid)),
      receiptItems: await tx.select().from(receiptItems).where(eq(receiptItems.householdId, hid)),
      receiptPhotosNote: "Receipt photos aren't included in this file. Open a receipt in Plenty to see or save its photo.",
      customProducts: await tx.select().from(products).where(eq(products.householdId, hid)),
      learnedReceiptWording: await tx.select().from(productAliases).where(eq(productAliases.householdId, hid)),
      predictions: await tx.select().from(predictions).where(eq(predictions.householdId, hid)),
      mealPlans: await tx.select().from(mealPlans).where(eq(mealPlans.householdId, hid)),
      mealPlan: await tx.select().from(mealPlanItems).where(eq(mealPlanItems.householdId, hid)),
      mealPreferences: await tx.select().from(mealPreferences).where(eq(mealPreferences.householdId, hid)),
      recipes: householdMeals.map((m) => ({ ...m, ingredients: householdIngredients.filter((i) => i.mealId === m.id) })),
      shoppingLists: await tx.select().from(shoppingLists).where(eq(shoppingLists.householdId, hid)),
      shoppingList: await tx.select().from(shoppingListItems).where(eq(shoppingListItems.householdId, hid)),
      shoppingListSources: await tx.select().from(shoppingListItemSources).where(eq(shoppingListItemSources.householdId, hid)),
      // Invite codes are credentials, so only their history is exported.
      invitations: await tx
        .select({
          id: householdInvitations.id,
          email: householdInvitations.email,
          role: householdInvitations.role,
          createdAt: householdInvitations.createdAt,
          expiresAt: householdInvitations.expiresAt,
          acceptedAt: householdInvitations.acceptedAt,
          revokedAt: householdInvitations.revokedAt,
        })
        .from(householdInvitations)
        .where(eq(householdInvitations.householdId, hid)),
      yourNotifications: await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.householdId, hid), eq(notifications.userId, ctx.user.id))),
      yourNotificationSettings: await tx
        .select()
        .from(notificationSettings)
        .where(and(eq(notificationSettings.householdId, hid), eq(notificationSettings.userId, ctx.user.id))),
    };
  });
}
