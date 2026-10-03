import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { pool, systemDb } from "@/server/db/client";
import * as s from "@/server/db/schema";
import { buildHouseholdContext, type HouseholdContext } from "@/server/auth/build-context";
import { deleteAccount } from "@/server/auth/service";
import { analyticsSubject, track } from "@/server/analytics";
import { planAccountDeletion } from "@/server/services/account-deletion";
import { acceptInvitation, createInvitation, deleteHousehold } from "@/server/services/household";
import { addManagedMember, setMemberFoodRules, updateMember } from "@/server/services/members";
import { addItems } from "@/server/services/inventory";
import { receiptImageKey, saveFile } from "@/server/storage/files";
import { makeHousehold } from "../helpers/db";

const PASSWORD = "correct-horse-battery";
const STORAGE = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? ".data/uploads");

/** Every public table that has a household_id column, found from the database itself so a future table can't be forgotten. */
async function householdTables(): Promise<string[]> {
  const r = await systemDb.execute<{ table_name: string }>(
    sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'household_id' order by table_name`,
  );
  return r.rows.map((row) => row.table_name);
}

async function rowCount(table: string, householdId: string): Promise<number> {
  const r = await systemDb.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.identifier(table)} where household_id = ${householdId}`);
  return Number(r.rows[0].n);
}

async function countsFor(householdId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await householdTables()) out[t] = await rowCount(t, householdId);
  return out;
}

/** A row in every table that belongs to a household. `joiner` is a second account holder (for member-level rows). */
async function populate(ctx: HouseholdContext, joiner?: HouseholdContext) {
  const hid = ctx.household.id;
  const day = "2026-09-30";
  const now = new Date();
  const [product] = await systemDb.insert(s.products).values({ householdId: hid, slug: `custom-${hid.slice(0, 8)}`, name: "Nonna's sauce" }).returning();
  await systemDb.insert(s.productAliases).values({ householdId: hid, aliasKey: "nonna sugo", productId: product.id });
  await systemDb.insert(s.productBarcodes).values({ householdId: hid, barcode: "9300633123456", productId: product.id, name: "Nonna's sauce", source: "household" });
  const [receipt] = await systemDb.insert(s.receipts).values({ householdId: hid, uploadedBy: ctx.user.id, status: "needs_review", storeName: "Woolworths", rawText: "W/M FULL CREAM 2L" }).returning();
  const key = receiptImageKey(hid, receipt.id);
  await saveFile(key, Buffer.from("receipt photo"));
  await systemDb.update(s.receipts).set({ imagePath: key }).where(eq(s.receipts.id, receipt.id));
  await systemDb.insert(s.receiptItems).values({ receiptId: receipt.id, householdId: hid, lineIndex: 0, rawText: "W/M FULL CREAM 2L", name: "Milk" });
  const [item] = await systemDb.insert(s.inventoryItems).values({ householdId: hid, name: "Milk", quantity: 2, productId: product.id }).returning();
  await systemDb.insert(s.inventoryEvents).values({ householdId: hid, inventoryItemId: item.id, type: "added" });
  await systemDb.insert(s.consumptionEvents).values({ householdId: hid, productId: product.id, outcome: "consumed", amountUsedBase: 1, baseUnit: "each", startedAt: now, endedAt: now, durationDays: 3, householdSize: 2 });
  await systemDb.insert(s.consumptionStats).values({ householdId: hid, productId: product.id, baseUnit: "each" });
  await systemDb.insert(s.predictions).values({ householdId: hid, productId: product.id, name: "Milk", remainingBase: 1, baseUnit: "each", dailyRate: 1, daysRemaining: 1, daysLow: 1, daysHigh: 2, runOutOn: day, confidence: "low", basis: "estimate", reason: "test" });
  const [meal] = await systemDb.insert(s.meals).values({ householdId: hid, source: "user", slug: `meal-${hid.slice(0, 8)}`, name: "Pasta", timeMinutes: 20 }).returning();
  await systemDb.insert(s.mealIngredients).values({ mealId: meal.id, householdId: hid, position: 0, name: "Pasta" });
  await systemDb.insert(s.contentReports).values({ householdId: hid, reporterUserId: ctx.user.id, mealId: meal.id, mealName: "Pasta", reason: "other" });
  await systemDb.insert(s.mealPreferences).values({ householdId: hid, mealId: meal.id, rating: 1 });
  const [plan] = await systemDb.insert(s.mealPlans).values({ householdId: hid, startDate: day, endDate: day }).returning();
  const [planItem] = await systemDb.insert(s.mealPlanItems).values({ mealPlanId: plan.id, householdId: hid, date: day, mealId: meal.id, servings: 2 }).returning();
  const [list] = await systemDb.select().from(s.shoppingLists).where(eq(s.shoppingLists.householdId, hid));
  const [listItem] = await systemDb.insert(s.shoppingListItems).values({ listId: list.id, householdId: hid, itemKey: "milk", name: "Milk" }).returning();
  await systemDb.insert(s.shoppingListItemSources).values({ itemId: listItem.id, householdId: hid, source: "meal_plan", mealPlanItemId: planItem.id });
  await systemDb.insert(s.recurringItems).values({ householdId: hid, name: "Bread", intervalDays: 7, nextDueOn: day });
  await systemDb.insert(s.usageCounters).values({ householdId: hid, metric: "receipt_scans", period: "2026-09", count: 3 });
  await systemDb.insert(s.billingEvents).values({ provider: "web", eventId: `evt_${hid}`, type: "invoice.paid", householdId: hid, summary: "paid" });
  await systemDb.insert(s.householdInvitations).values({ householdId: hid, code: `CODE${hid.slice(0, 8)}`, createdBy: ctx.user.id, expiresAt: new Date(Date.now() + 86_400_000) });
  await systemDb.insert(s.notifications).values({ householdId: hid, userId: ctx.user.id, type: "insight", title: "Hi", body: "There", dedupeKey: `t:${hid}` });
  const profile = await addManagedMember(ctx, { name: "Sam", role: "child" });
  await setMemberFoodRules(ctx, profile.id, { diets: ["vegetarian"], allergies: ["peanuts"], dislikedIngredients: [] });
  // A private item and a food rule belonging to the second account, when there is one.
  if (joiner) {
    await addItems(joiner, [{ name: "Joiner's secret treat", visibility: "private", ownerMemberId: joiner.member.id }]);
    await setMemberFoodRules(joiner, joiner.member.id, { diets: [], allergies: ["sesame"], dislikedIngredients: [] });
  }
  await track("receipt_confirmed", { householdId: hid, userId: ctx.user.id }, { lines: 1, corrected: 0 });
  await systemDb.insert(s.rateLimits).values({ key: `receipt-upload:${hid}`, windowStart: now, count: 1 });
  return { receiptKey: key, subject: analyticsSubject(hid)! };
}

async function join(owner: HouseholdContext, role: "member" | "child" = "member"): Promise<HouseholdContext> {
  const other = await makeHousehold({ name: "Their own place", plan: "plus" });
  const invite = await createInvitation(owner);
  await acceptInvitation(other.user, invite.code);
  let ctx = (await buildHouseholdContext(other.user, owner.household.id))!;
  if (role !== "member") {
    await updateMember(owner, ctx.member.id, { role });
    ctx = (await buildHouseholdContext(other.user, owner.household.id))!;
  }
  return ctx;
}

describe("deleting an account and a household", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("removes every row that belongs to the household, in every table, and touches no other household", async () => {
    const ctx = await makeHousehold({ name: "Doomed", plan: "family" });
    const bystander = await makeHousehold({ name: "Bystander", plan: "family" });
    const { receiptKey, subject } = await populate(ctx);
    await populate(bystander);

    // The check below is only meaningful if every table was populated: a new table fails here until it is.
    const tables = await householdTables();
    const before = await countsFor(ctx.household.id);
    const empty = tables.filter((t) => before[t] === 0);
    expect(empty, `populate() in this test has nothing for: ${empty.join(", ")}. Add a row for each new table so deletion is proven for it.`).toEqual([]);
    expect(tables).toEqual(expect.arrayContaining(["receipts", "inventory_items", "subscriptions", "billing_events", "member_food_rules", "usage_counters", "notifications"]));
    const bystanderBefore = await countsFor(bystander.household.id);
    expect(existsSync(path.join(STORAGE, receiptKey))).toBe(true);

    const result = await deleteAccount(ctx.user.id, PASSWORD);
    expect(result.deletedHouseholdIds).toEqual([ctx.household.id]);

    const after = await countsFor(ctx.household.id);
    expect(after).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
    // The account and what hangs off it.
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, ctx.user.id))).toHaveLength(0);
    expect(await systemDb.select().from(s.profiles).where(eq(s.profiles.userId, ctx.user.id))).toHaveLength(0);
    expect(await systemDb.select().from(s.sessions).where(eq(s.sessions.userId, ctx.user.id))).toHaveLength(0);
    expect(await systemDb.select().from(s.households).where(eq(s.households.id, ctx.household.id))).toHaveLength(0);
    // Outside the household tables: analytics, photos, short-lived counters.
    expect(await systemDb.select().from(s.analyticsEvents).where(eq(s.analyticsEvents.subject, subject))).toHaveLength(0);
    expect(existsSync(path.join(STORAGE, receiptKey))).toBe(false);
    expect(existsSync(path.join(STORAGE, ctx.household.id))).toBe(false);
    expect(await systemDb.select().from(s.rateLimits).where(sql`${s.rateLimits.key} like ${`%${ctx.household.id}`}`)).toHaveLength(0);
    // Payment notifications stay only as a record with the household link removed.
    const events = await systemDb.select().from(s.billingEvents).where(eq(s.billingEvents.eventId, `evt_${ctx.household.id}`));
    expect(events).toHaveLength(1);
    expect(events[0].householdId).toBeNull();
    // Nobody else was touched.
    expect(await countsFor(bystander.household.id)).toEqual(bystanderBefore);
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, bystander.user.id))).toHaveLength(1);
  });

  it("needs the right password, and refuses the demo account, deleting nothing", async () => {
    const ctx = await makeHousehold({ plan: "plus" });
    await expect(deleteAccount(ctx.user.id, "not the password")).rejects.toThrow(/password/i);
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, ctx.user.id))).toHaveLength(1);
    expect(await systemDb.select().from(s.households).where(eq(s.households.id, ctx.household.id))).toHaveLength(1);
    await systemDb.update(s.users).set({ isDemo: true }).where(eq(s.users.id, ctx.user.id));
    await expect(deleteAccount(ctx.user.id, PASSWORD)).rejects.toThrow(/demo/i);
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, ctx.user.id))).toHaveLength(1);
  });

  it("leaving a shared household: private items and personal data go, shared things stay, their own household is deleted", async () => {
    const owner = await makeHousehold({ name: "Shared home", plan: "family" });
    const joiner = await join(owner, "member");
    const own = joiner.user.id;
    const theirOwnHousehold = (await systemDb.select().from(s.householdMembers).where(eq(s.householdMembers.userId, own))).map((m) => m.householdId).find((h) => h !== owner.household.id)!;
    await populate(owner, joiner);
    // Something the joiner shared (not private): stays with the household.
    await addItems(joiner, [{ name: "Joiner's shared yoghurt", ownerMemberId: joiner.member.id, visibility: "household" }]);
    // An invitation they sent, and one addressed to their email.
    await systemDb.insert(s.householdInvitations).values({ householdId: owner.household.id, code: "JOINERSENT01", createdBy: own, expiresAt: new Date(Date.now() + 86_400_000) });
    await systemDb.insert(s.householdInvitations).values({ householdId: owner.household.id, code: "TOJOINER0001", email: joiner.user.email.toUpperCase(), expiresAt: new Date(Date.now() + 86_400_000) });
    const joinerMember = joiner.member.id;

    const result = await deleteAccount(own, PASSWORD);
    expect(result.leftHouseholdIds).toEqual([owner.household.id]);
    expect(result.deletedHouseholdIds).toEqual([theirOwnHousehold]);

    // The shared household carries on.
    expect(await systemDb.select().from(s.households).where(eq(s.households.id, owner.household.id))).toHaveLength(1);
    const items = await systemDb.select().from(s.inventoryItems).where(eq(s.inventoryItems.householdId, owner.household.id));
    expect(items.map((i) => i.name)).not.toContain("Joiner's secret treat");
    expect(items.map((i) => i.name)).toEqual(expect.arrayContaining(["Milk", "Joiner's shared yoghurt"]));
    expect(items.find((i) => i.name === "Joiner's shared yoghurt")?.ownerMemberId).toBeNull();
    // Their own food rules, membership, notifications and invitations are gone; the owner's are not.
    expect(await systemDb.select().from(s.memberFoodRules).where(eq(s.memberFoodRules.memberId, joinerMember))).toHaveLength(0);
    expect(await systemDb.select().from(s.householdMembers).where(eq(s.householdMembers.id, joinerMember))).toHaveLength(0);
    expect(await systemDb.select().from(s.notifications).where(eq(s.notifications.userId, own))).toHaveLength(0);
    const invites = await systemDb.select().from(s.householdInvitations).where(eq(s.householdInvitations.householdId, owner.household.id));
    expect(invites.map((i) => i.code)).not.toEqual(expect.arrayContaining(["JOINERSENT01"]));
    expect(invites.map((i) => i.code)).not.toEqual(expect.arrayContaining(["TOJOINER0001"]));
    expect(invites.length).toBeGreaterThan(0);
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, owner.user.id))).toHaveLength(1);
    // Their own household went entirely.
    expect(Object.values(await countsFor(theirOwnHousehold)).every((n) => n === 0)).toBe(true);
    // The household still has an owner.
    const owners = await systemDb.select().from(s.householdMembers).where(and(eq(s.householdMembers.householdId, owner.household.id), sql`${s.householdMembers.role}::text = 'owner'`));
    expect(owners).toHaveLength(1);
  });

  it("never leaves a household without an owner: the only owner of a shared household is asked to choose a successor first", async () => {
    const owner = await makeHousehold({ name: "Only owner", plan: "family" });
    const other = await join(owner, "member");
    const before = await planAccountDeletion(owner.user.id);
    expect(before.households.find((h) => h.id === owner.household.id)).toMatchObject({ outcome: "blocked", otherAccountHolders: 1 });
    expect(before.blockedBy).toHaveLength(1);

    await expect(deleteAccount(owner.user.id, PASSWORD)).rejects.toThrow(/only owner of “Only owner”/);
    // Nothing was deleted, including the other household this person owns alone.
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, owner.user.id))).toHaveLength(1);
    expect(await systemDb.select().from(s.householdMembers).where(eq(s.householdMembers.userId, owner.user.id))).not.toHaveLength(0);

    // Once someone else is an owner, it goes ahead and nobody is promoted behind anyone's back.
    await updateMember(owner, other.member.id, { role: "owner" });
    const ready = await planAccountDeletion(owner.user.id);
    expect(ready.households.find((h) => h.id === owner.household.id)?.outcome).toBe("leave");
    await deleteAccount(owner.user.id, PASSWORD);
    const members = await systemDb.select().from(s.householdMembers).where(eq(s.householdMembers.householdId, owner.household.id));
    expect(members.map((m) => m.role)).toContain("owner");
    expect(members.every((m) => m.userId !== owner.user.id)).toBe(true);
  });

  it("won't hand a household to a child account", async () => {
    const owner = await makeHousehold({ name: "Owner and child", plan: "family" });
    await join(owner, "child");
    await expect(deleteAccount(owner.user.id, PASSWORD)).rejects.toThrow(/make one of them an owner/i);
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, owner.user.id))).toHaveLength(1);
  });

  it("deleting a household as its owner removes every row for it, for everyone in it", async () => {
    const owner = await makeHousehold({ name: "Owner deletes", plan: "family" });
    const joiner = await join(owner, "member");
    const bystander = await makeHousehold({ name: "Bystander 2", plan: "family" });
    const { receiptKey, subject } = await populate(owner, joiner);
    await populate(bystander);
    const bystanderBefore = await countsFor(bystander.household.id);

    await deleteHousehold(owner);

    const tables = await householdTables();
    expect(await countsFor(owner.household.id)).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
    expect(existsSync(path.join(STORAGE, receiptKey))).toBe(false);
    expect(await systemDb.select().from(s.analyticsEvents).where(eq(s.analyticsEvents.subject, subject))).toHaveLength(0);
    // The people in it keep their accounts (and their own households).
    expect(await systemDb.select().from(s.users).where(eq(s.users.id, joiner.user.id))).toHaveLength(1);
    expect(await countsFor(bystander.household.id)).toEqual(bystanderBefore);
  });

  it("only an owner can delete a household", async () => {
    const owner = await makeHousehold({ plan: "family" });
    const member = await join(owner, "member");
    await expect(deleteHousehold(member)).rejects.toThrow(/owner/i);
    expect(await systemDb.select().from(s.households).where(eq(s.households.id, owner.household.id))).toHaveLength(1);
  });

  describe("subscriptions", () => {
    const withSubscription = async (ctx: HouseholdContext, values: Partial<typeof s.subscriptions.$inferInsert>) => {
      await systemDb.delete(s.subscriptions).where(eq(s.subscriptions.householdId, ctx.household.id));
      await systemDb.insert(s.subscriptions).values({ householdId: ctx.household.id, plan: "plus", period: "annual", status: "active", autoRenew: true, ...values });
    };

    it("tells the person to cancel an App Store subscription, and never claims it was cancelled", async () => {
      const ctx = await makeHousehold({ plan: "plus" });
      await withSubscription(ctx, { provider: "apple", providerSubscriptionId: `apple-${ctx.household.id}` });
      const plan = await planAccountDeletion(ctx.user.id);
      expect(plan.households[0].subscription).toMatchObject({ provider: "apple", planName: "Plenty Plus", autoRenew: true, cancelledOnDelete: false });
      const result = await deleteAccount(ctx.user.id, PASSWORD);
      expect(result.storeSubscriptions).toEqual(["apple"]);
      expect(await systemDb.select().from(s.subscriptions).where(eq(s.subscriptions.householdId, ctx.household.id))).toHaveLength(0);
    });

    it("tells the person about a Google Play subscription too", async () => {
      const ctx = await makeHousehold({ plan: "plus" });
      await withSubscription(ctx, { provider: "google", providerSubscriptionId: `google-${ctx.household.id}` });
      expect((await deleteAccount(ctx.user.id, PASSWORD)).storeSubscriptions).toEqual(["google"]);
    });

    it("says nothing about a free plan or one granted by hand", async () => {
      const free = await makeHousehold({ plan: "free" });
      expect((await planAccountDeletion(free.user.id)).households[0].subscription).toBeNull();
      const manual = await makeHousehold({ plan: "plus" });
      expect((await planAccountDeletion(manual.user.id)).households[0].subscription).toBeNull();
    });

    it("a web subscription that can't be cancelled stops the deletion, so nobody is left paying for nothing", async () => {
      const ctx = await makeHousehold({ plan: "plus" });
      await withSubscription(ctx, { provider: "web", providerSubscriptionId: "sub_test_123", providerCustomerId: "cus_test" });
      expect((await planAccountDeletion(ctx.user.id)).households[0].subscription).toMatchObject({ provider: "web", cancelledOnDelete: true });
      // No Stripe credentials in tests, so cancelling fails, and nothing may be deleted.
      await expect(deleteAccount(ctx.user.id, PASSWORD)).rejects.toThrow();
      expect(await systemDb.select().from(s.users).where(eq(s.users.id, ctx.user.id))).toHaveLength(1);
      expect(await systemDb.select().from(s.households).where(eq(s.households.id, ctx.household.id))).toHaveLength(1);
      await expect(deleteHousehold(ctx)).rejects.toThrow();
      expect(await systemDb.select().from(s.households).where(eq(s.households.id, ctx.household.id))).toHaveLength(1);
    });
  });
});
