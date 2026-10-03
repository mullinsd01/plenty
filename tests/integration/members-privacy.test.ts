import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { pool, systemDb, withUser } from "@/server/db/client";
import { consumptionStats, inventoryItems, notifications, recurringItems, shoppingListItems } from "@/server/db/schema";
import { buildHouseholdContext, type HouseholdContext } from "@/server/auth/build-context";
import { acceptInvitation, createInvitation } from "@/server/services/household";
import { addItems, finishItem, getInventory } from "@/server/services/inventory";
import { addManagedMember, combinedFoodRules, getMemberFoodRules, listMembers, removeMember, setMemberFoodRules, updateMember } from "@/server/services/members";
import { createRecurring } from "@/server/services/recurring";
import { addManualItem, addRequest, getShoppingList, removeShoppingItem } from "@/server/services/shopping";
import { makeHousehold, setHouseholdPlan } from "../helpers/db";

/** A second account joined to `owner`'s household, as the invited person would see it. */
async function joinHousehold(owner: HouseholdContext, role: "member" | "child" = "member"): Promise<HouseholdContext> {
  const other = await makeHousehold({ name: "Their own place" });
  const invite = await createInvitation(owner);
  await acceptInvitation(other.user, invite.code);
  let ctx = (await buildHouseholdContext(other.user, owner.household.id))!;
  if (role !== "member") {
    await updateMember(owner, ctx.member.id, { role });
    ctx = (await buildHouseholdContext(other.user, owner.household.id))!;
  }
  return ctx;
}

describe("people, ownership and privacy", () => {
  let alex: HouseholdContext;
  let jordan: HouseholdContext;
  let ollie: HouseholdContext;

  beforeAll(async () => {
    alex = await makeHousehold({ name: "Harpers", plan: "family" });
    jordan = await joinHousehold(alex, "member");
    ollie = await joinHousehold(alex, "child");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("knows who is who and what each role may do", async () => {
    const people = await listMembers(alex);
    expect(people).toHaveLength(3);
    expect(people.find((p) => p.isYou)?.role).toBe("owner");
    expect(jordan.role).toBe("member");
    expect(ollie.role).toBe("child");
    // Only owners see email addresses.
    expect((await listMembers(jordan)).every((p) => p.email === null)).toBe(true);
  });

  describe("private items", () => {
    let privateId: string;
    let sharedId: string;

    beforeAll(async () => {
      [privateId] = await addItems(alex, [{ name: "Protein bars", ownerMemberId: alex.member.id, visibility: "private" }]);
      [sharedId] = await addItems(alex, [{ name: "Alex's Pepsi Max", ownerMemberId: alex.member.id }]);
    });

    it("the owner sees them; housemates never do, through the app or the database", async () => {
      expect((await getInventory(alex)).items.some((i) => i.id === privateId)).toBe(true);
      for (const other of [jordan, ollie]) {
        expect((await getInventory(other)).items.some((i) => i.id === privateId)).toBe(false);
        const raw = await withUser(other.user.id, (tx) => tx.select({ id: inventoryItems.id }).from(inventoryItems).where(eq(inventoryItems.id, privateId)));
        expect(raw).toHaveLength(0);
        // …and a direct write can't touch what isn't visible.
        const hit = await withUser(other.user.id, (tx) => tx.update(inventoryItems).set({ name: "Hacked" }).where(eq(inventoryItems.id, privateId)).returning());
        expect(hit).toHaveLength(0);
      }
    });

    it("an item that belongs to someone but is shared is visible to the household and labelled", async () => {
      const seen = (await getInventory(jordan)).items.find((i) => i.id === sharedId);
      expect(seen?.ownerName).toBeTruthy();
      expect(seen?.isMine).toBe(false);
      expect(seen?.visibility).toBe("household");
    });

    it("nobody can make something private on someone else's behalf", async () => {
      await expect(addItems(jordan, [{ name: "Sneaky", ownerMemberId: alex.member.id, visibility: "private" }])).rejects.toThrow(/Only you/);
    });

    it("the free plan keeps working but can't make things private", async () => {
      const free = await makeHousehold({ name: "Freebies", plan: "free" });
      await expect(addItems(free, [{ name: "Treat", ownerMemberId: free.member.id, visibility: "private" }])).rejects.toThrow(/Plenty Family/);
      // Labelling who something is for is still fine.
      await expect(addItems(free, [{ name: "Treat", ownerMemberId: free.member.id }])).resolves.toHaveLength(1);
    });

    it("a child may only add things for themselves, and can't change other people's", async () => {
      await expect(addItems(ollie, [{ name: "Apple", ownerMemberId: alex.member.id }])).rejects.toThrow(/for yourself/);
      const [own] = await addItems(ollie, [{ name: "Apple" }]);
      const row = (await getInventory(ollie)).items.find((i) => i.id === own);
      expect(row?.ownerMemberId).toBe(ollie.member.id);
      await expect(finishItem(ollie, sharedId, "consumed")).rejects.toThrow();
      const still = await systemDb.select({ status: inventoryItems.status }).from(inventoryItems).where(eq(inventoryItems.id, sharedId));
      expect(still[0].status).toBe("active");
    });
  });

  describe("each person's own pattern", () => {
    it("learns Alex's and Jordan's pace separately, and keeps private history private", async () => {
      const day = 86_400_000;
      const buy = async (ctx: HouseholdContext, daysAgo: number, lasted: number, visibility: "household" | "private" = "household") => {
        const at = new Date(Date.now() - daysAgo * day);
        const [id] = await addItems(ctx, [{ name: "Sparkling water", quantity: 12, unit: "can", purchasedAt: at, ownerMemberId: ctx.member.id, visibility }]);
        await systemDb.update(inventoryItems).set({ purchasedAt: at, levelUpdatedAt: at }).where(eq(inventoryItems.id, id));
        await finishItem(ctx, id, "consumed");
        void lasted;
        return id;
      };
      await buy(alex, 40, 8);
      await buy(alex, 30, 8);
      await buy(jordan, 40, 30);
      await buy(alex, 20, 8, "private");

      const stats = await systemDb.select({ scope: consumptionStats.scope }).from(consumptionStats).where(eq(consumptionStats.householdId, alex.household.id));
      const scopes = new Set(stats.map((s) => s.scope));
      expect(scopes.has(`member:${alex.member.id}`)).toBe(true);
      expect(scopes.has(`member:${jordan.member.id}`)).toBe(true);
      expect(scopes.has(`private:${alex.member.id}`)).toBe(true);
      // A housemate can't see Alex's private pattern, but can see the shared ones.
      const seenByJordan = await withUser(jordan.user.id, (tx) => tx.select({ scope: consumptionStats.scope }).from(consumptionStats));
      expect(seenByJordan.some((s) => s.scope.startsWith("private:"))).toBe(false);
      expect(seenByJordan.some((s) => s.scope === `member:${alex.member.id}`)).toBe(true);
    });

    it("on a plan without individual patterns, everyone's shared items feed one household pattern", async () => {
      const plus = await makeHousehold({ name: "Plus household", plan: "plus" });
      const other = await joinHousehold(plus);
      const day = 86_400_000;
      for (const [ctx, ago] of [[plus, 30], [other, 20]] as const) {
        const at = new Date(Date.now() - ago * day);
        const [id] = await addItems(ctx, [{ name: "Oat milk", quantity: 1, unit: "l", purchasedAt: at, ownerMemberId: ctx.member.id }]);
        await systemDb.update(inventoryItems).set({ purchasedAt: at, levelUpdatedAt: at }).where(eq(inventoryItems.id, id));
        await finishItem(ctx, id, "consumed");
      }
      const rows = await systemDb.select({ scope: consumptionStats.scope }).from(consumptionStats).where(eq(consumptionStats.householdId, plus.household.id));
      expect(rows.map((r) => r.scope)).toEqual(["household"]);
    });
  });

  describe("shopping list, requests and roles", () => {
    it("keeps each person's line separate: Pepsi Max for Alex isn't Pepsi Max for Jordan", async () => {
      await addManualItem(alex, { name: "Pepsi Max", ownerMemberId: alex.member.id });
      await addManualItem(jordan, { name: "Pepsi Max", ownerMemberId: jordan.member.id, note: "Black cans" });
      const lines = (await getShoppingList(alex)).items.filter((i) => /pepsi max/i.test(i.name));
      expect(lines.map((l) => l.ownerName).sort()).toHaveLength(2);
      expect(new Set(lines.map((l) => l.ownerMemberId)).size).toBe(2);
      expect(lines.find((l) => l.ownerMemberId === jordan.member.id)?.note).toBe("Black cans");
    });

    it("anyone can ask for something and the adults are told; it shows under their name", async () => {
      const asked = await addRequest(jordan, { name: "Oat milk", note: "The barista one" });
      expect(asked.alreadyOnList).toBe(false);
      const line = (await getShoppingList(alex)).items.find((i) => i.id === asked.id);
      expect(line?.requestedByName).toBeTruthy();
      expect(line?.source).toBe("request");
      const told = await systemDb.select().from(notifications).where(and(eq(notifications.userId, alex.user.id), eq(notifications.type, "request")));
      expect(told.length).toBeGreaterThan(0);
      // The same person asking again doesn't duplicate it.
      expect((await addRequest(jordan, { name: "oat milk" })).id).toBe(asked.id);
    });

    it("a child can ask, can see the list, and can only change their own requests", async () => {
      const mine = await addRequest(ollie, { name: "Yoghurt pouches" });
      await expect(addManualItem(ollie, { name: "Chips" })).rejects.toThrow(/can add requests/);
      const list = await getShoppingList(ollie);
      expect(list.items.some((i) => i.id === mine.id && i.canChange)).toBe(true);
      const adultLine = list.items.find((i) => /oat milk/i.test(i.name))!;
      expect(adultLine.canChange).toBe(false);
      await expect(removeShoppingItem(ollie, adultLine.id)).rejects.toThrow(/can add requests|only change/);
      await expect(removeShoppingItem(ollie, mine.id)).resolves.toBeUndefined();
    });

    it("a child can't see Alex's private list lines either", async () => {
      await addManualItem(alex, { name: "Private chocolate", ownerMemberId: alex.member.id, visibility: "private" });
      expect((await getShoppingList(alex)).items.some((i) => /private chocolate/i.test(i.name))).toBe(true);
      expect((await getShoppingList(ollie)).items.some((i) => /private chocolate/i.test(i.name))).toBe(false);
      expect((await getShoppingList(jordan)).items.some((i) => /private chocolate/i.test(i.name))).toBe(false);
      const rows = await withUser(jordan.user.id, (tx) => tx.select().from(shoppingListItems).where(eq(shoppingListItems.name, "Private chocolate")));
      expect(rows).toHaveLength(0);
    });
  });

  describe("food rules", () => {
    it("are each person's own, combined for meals without saying whose", async () => {
      const profile = await addManagedMember(alex, { name: "Sam", role: "child" });
      await setMemberFoodRules(alex, profile.id, { diets: ["vegetarian"], allergies: ["sesame"], dislikedIngredients: [] });
      await setMemberFoodRules(jordan, jordan.member.id, { diets: [], allergies: ["shellfish"], dislikedIngredients: ["olives"] });
      const combined = await withUser(alex.user.id, (tx) => combinedFoodRules(tx, alex.household.id));
      expect(combined.allergies).toEqual(expect.arrayContaining(["sesame", "shellfish"]));
      expect(combined.diets).toContain("vegetarian");
      // Alex can't read Jordan's own rules, and Jordan can't set Alex's.
      expect((await getMemberFoodRules(alex, jordan.member.id)).allergies).toEqual([]);
      await expect(setMemberFoodRules(jordan, alex.member.id, { diets: [], allergies: ["gluten"], dislikedIngredients: [] })).rejects.toThrow();
      // A child can't read anyone's.
      expect((await getMemberFoodRules(ollie, jordan.member.id)).allergies).toEqual([]);
    });
  });

  describe("plans never take basics away", () => {
    it("the free plan caps what can be added, but nothing is removed and the list still works", async () => {
      const free = await makeHousehold({ name: "Small", plan: "free" });
      await addItems(free, Array.from({ length: 50 }, (_, i) => ({ name: `Thing ${i + 1}` })));
      await expect(addItems(free, [{ name: "One too many" }])).rejects.toThrow(/full on this plan|room for/);
      // The list and requests are never gated.
      await expect(addManualItem(free, { name: "Bread" })).resolves.toBeTruthy();
      await expect(addRequest(free, { name: "Biscuits" })).resolves.toBeTruthy();
      // Finishing something frees a place.
      const inv = await getInventory(free);
      await finishItem(free, inv.items[0].id, "consumed");
      await expect(addItems(free, [{ name: "Fits now" }])).resolves.toHaveLength(1);
    });

    it("the free plan limits people, and an upgrade lifts it", async () => {
      const home = await makeHousehold({ name: "Two only", plan: "free" });
      await addManagedMember(home, { name: "Second" });
      await expect(addManagedMember(home, { name: "Third" })).rejects.toThrow(/room|plan/i);
      const upgraded = await setHouseholdPlan(home, "plus");
      await expect(addManagedMember(upgraded, { name: "Third" })).resolves.toBeTruthy();
    });

    it("regular purchases are a Plus feature and go on the list when due", async () => {
      const free = await makeHousehold({ name: "No repeats", plan: "free" });
      await expect(createRecurring(free, { name: "Milk", intervalDays: 7 })).rejects.toThrow(/Plenty Plus/);
      const plus = await setHouseholdPlan(free, "plus");
      const id = await createRecurring(plus, { name: "Coffee beans", quantity: 1, unit: "pack", intervalDays: 14 });
      // Not due yet: nothing on the list.
      expect((await getShoppingList(plus)).items.some((i) => /coffee beans/i.test(i.name))).toBe(false);
      await systemDb.update(recurringItems).set({ nextDueOn: "2000-01-01" }).where(eq(recurringItems.id, id));
      const line = (await getShoppingList(plus, new Date(Date.now() + 11 * 60_000))).items.find((i) => /coffee beans/i.test(i.name));
      expect(line?.recurring).toBe(true);
      // …and it won't be added twice.
      const again = (await getShoppingList(plus, new Date(Date.now() + 25 * 60_000))).items.filter((i) => /coffee beans/i.test(i.name));
      expect(again).toHaveLength(1);
    });
  });

  describe("removing someone", () => {
    it("takes their private things with them and leaves what they shared", async () => {
      const leaver = await joinHousehold(alex, "member");
      const [priv] = await addItems(leaver, [{ name: "Leaver's secret", ownerMemberId: leaver.member.id, visibility: "private" }]);
      const [shared] = await addItems(leaver, [{ name: "Leaver's shared", ownerMemberId: leaver.member.id }]);
      await removeMember(alex, leaver.member.id);
      const gone = await systemDb.select({ id: inventoryItems.id }).from(inventoryItems).where(eq(inventoryItems.id, priv));
      expect(gone).toHaveLength(0);
      const [s] = await systemDb.select({ status: inventoryItems.status }).from(inventoryItems).where(eq(inventoryItems.id, shared));
      expect(s.status).toBe("active");
    });
  });
});
