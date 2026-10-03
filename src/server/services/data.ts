import "server-only";
import { and, eq } from "drizzle-orm";
import type { HouseholdContext } from "@/server/auth/context";
import { withUser } from "@/server/db/client";
import { requireCapability } from "@/server/permissions";
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
  memberFoodRules,
  notifications,
  notificationSettings,
  predictions,
  preferences,
  productAliases,
  productBarcodes,
  products,
  receiptItems,
  receipts,
  shoppingListItemSources,
  shoppingListItems,
  shoppingLists,
  subscriptions,
  usageCounters,
  recurringItems,
} from "@/server/db/schema";
import { listMembers } from "./members";

/**
 * A complete, human-readable export of the household's data. Everything is
 * read through the member's row-level-security context.
 */
export async function exportHouseholdData(ctx: HouseholdContext) {
  requireCapability(ctx, "export_data");
  const members = await listMembers(ctx);
  return withUser(ctx.user.id, async (tx) => {
    const hid = ctx.household.id;
    const [household] = await tx.select().from(households).where(eq(households.id, hid));
    const [prefs] = await tx.select().from(preferences).where(eq(preferences.householdId, hid));
    const householdMeals = await tx.select().from(meals).where(eq(meals.householdId, hid));
    const householdIngredients = await tx.select().from(mealIngredients).where(eq(mealIngredients.householdId, hid));
    const inventory = await tx.select().from(inventoryItems).where(eq(inventoryItems.householdId, hid));
    const consumption = await tx.select().from(consumptionEvents).where(eq(consumptionEvents.householdId, hid));
    const learnedStats = await tx.select().from(consumptionStats).where(eq(consumptionStats.householdId, hid));
    const receiptItemRows = await tx.select().from(receiptItems).where(eq(receiptItems.householdId, hid));
    const predictionRows = await tx.select().from(predictions).where(eq(predictions.householdId, hid));
    const recurring = await tx.select().from(recurringItems).where(eq(recurringItems.householdId, hid));
    const barcodeRows = await tx.select().from(productBarcodes).where(eq(productBarcodes.householdId, hid));
    const shoppingList = await tx.select().from(shoppingListItems).where(eq(shoppingListItems.householdId, hid));
    const aliases = await tx.select().from(productAliases).where(eq(productAliases.householdId, hid));
    const householdProducts = await tx.select().from(products).where(eq(products.householdId, hid));
    // Plenty makes a household "product" for anything it doesn't know, named after the item, and someone's private item
    // makes one too. Products are the household's, so a housemate's export would carry that name. A product is exported
    // only when something this person can see uses it.
    const inUse = new Set<string>();
    // (Every product Plenty works with gets an empty household-wide stats row; that alone isn't use.)
    const learnedSomething = learnedStats.filter((s) => s.purchaseCount > 0 || s.observations > 0 || s.stapleOverride !== null);
    for (const rows of [inventory, consumption, learnedSomething, receiptItemRows, predictionRows, recurring, barcodeRows, shoppingList, householdIngredients]) {
      for (const row of rows) if (row.productId) inUse.add(row.productId);
    }
    const hiddenProducts = new Set(householdProducts.filter((p) => !inUse.has(p.id)).map((p) => p.id));
    return {
      exportedAt: new Date().toISOString(),
      format: "plenty-export/1",
      household,
      members: members.map((m) => ({ name: m.name, email: m.email, role: m.role, hasAccount: m.hasAccount, joinedAt: m.joinedAt })),
      preferences: prefs ?? null,
      inventory,
      inventoryEvents: await tx.select().from(inventoryEvents).where(eq(inventoryEvents.householdId, hid)),
      consumption,
      learnedStats,
      receipts: await tx.select().from(receipts).where(eq(receipts.householdId, hid)),
      receiptItems: receiptItemRows,
      receiptPhotosNote: "Receipt photos aren't included in this file. Open a receipt in Plenty to see or save its photo.",
      customProducts: householdProducts.filter((p) => !hiddenProducts.has(p.id)),
      learnedReceiptWording: aliases.filter((a) => !hiddenProducts.has(a.productId)),
      predictions: predictionRows,
      // Row-level security limits these to what this person may see: their own food rules (and those of people they look after).
      foodRules: await tx.select().from(memberFoodRules).where(eq(memberFoodRules.householdId, hid)),
      recurringItems: recurring,
      barcodes: barcodeRows,
      subscription: (await tx.select().from(subscriptions).where(eq(subscriptions.householdId, hid)))[0] ?? null,
      usage: await tx.select().from(usageCounters).where(eq(usageCounters.householdId, hid)),
      mealPlans: await tx.select().from(mealPlans).where(eq(mealPlans.householdId, hid)),
      mealPlan: await tx.select().from(mealPlanItems).where(eq(mealPlanItems.householdId, hid)),
      mealPreferences: await tx.select().from(mealPreferences).where(eq(mealPreferences.householdId, hid)),
      recipes: householdMeals.map((m) => ({ ...m, ingredients: householdIngredients.filter((i) => i.mealId === m.id) })),
      shoppingLists: await tx.select().from(shoppingLists).where(eq(shoppingLists.householdId, hid)),
      shoppingList,
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
