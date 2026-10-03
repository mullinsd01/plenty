/**
 * Regression tests from the security and privacy review: each one started as an attack that worked.
 * Plain-language rule behind them: nobody gets more than they were given, and nobody sees what
 * a housemate marked private.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { pool, systemDb } from "@/server/db/client";
import { consumptionEvents, householdMembers, households, inventoryEvents, inventoryItems, receiptItems, receipts, recurringItems } from "@/server/db/schema";
import { buildHouseholdContext, type HouseholdContext } from "@/server/auth/build-context";
import { acceptInvitation, createInvitation, leaveHousehold, revokeInvitations, switchHousehold, updateHouseholdBasics, updatePreferences } from "@/server/services/household";
import { addItems, answerCheckIn, finishItem, getInventory, getInventoryItem, updateItem } from "@/server/services/inventory";
import { exportHouseholdData } from "@/server/services/data";
import { addManagedMember, updateMember } from "@/server/services/members";
import { resetProductLearning, setPredictionsPaused } from "@/server/services/memory";
import { createRecurring } from "@/server/services/recurring";
import { removeMember } from "@/server/services/members";
import { confirmReceipt } from "@/server/services/receipts";
import { makeHousehold } from "../helpers/db";

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

async function rolesOf(householdId: string): Promise<Record<string, string>> {
  const rows = await systemDb.select().from(householdMembers).where(eq(householdMembers.householdId, householdId));
  return Object.fromEntries(rows.map((r) => [r.id, r.role]));
}

afterAll(async () => {
  await pool.end();
});

describe("who can become an owner", () => {
  it("leaving as the only owner never hands the household to a member or a child behind anyone's back", async () => {
    const withMember = await makeHousehold({ name: "Owner and member", plan: "family" });
    const member = await joinHousehold(withMember, "member");
    await expect(leaveHousehold(withMember)).rejects.toThrow(/owner/i);
    expect((await rolesOf(withMember.household.id))[member.member.id]).toBe("member");

    const withChild = await makeHousehold({ name: "Owner and child", plan: "family" });
    const child = await joinHousehold(withChild, "child");
    await expect(leaveHousehold(withChild)).rejects.toThrow(/owner/i);
    expect((await rolesOf(withChild.household.id))[child.member.id]).toBe("child");
    // Nothing happened to the owner either.
    expect(Object.values(await rolesOf(withChild.household.id)).sort()).toEqual(["child", "owner"]);
  });

  it("an owner can leave once someone else has been made an owner on purpose", async () => {
    const owner = await makeHousehold({ name: "Two owners", plan: "family" });
    const other = await joinHousehold(owner, "member");
    await updateMember(owner, other.member.id, { role: "owner" });
    await leaveHousehold(owner);
    expect(Object.values(await rolesOf(owner.household.id))).toEqual(["owner"]);
  });

  it("a person without an account can't be an owner, and doesn't count as the household's last owner", async () => {
    const owner = await makeHousehold({ name: "Profile owner", plan: "family" });
    const other = await joinHousehold(owner, "member");
    const profile = await addManagedMember(owner, { name: "Nan", role: "member" });
    // Somebody who can't sign in can't run the household.
    await expect(updateMember(owner, profile.id, { role: "owner" })).rejects.toThrow(/account/i);
    // And the real owner can still not demote themselves into an ownerless household.
    await expect(updateMember(owner, owner.member.id, { role: "member" })).rejects.toThrow(/at least one owner/i);
    expect((await rolesOf(owner.household.id))[owner.member.id]).toBe("owner");
    expect(other.role).toBe("member");
  });
});

describe("what a child account may do", () => {
  let owner: HouseholdContext;
  let child: HouseholdContext;
  let member: HouseholdContext;

  beforeAll(async () => {
    owner = await makeHousehold({ name: "Family with a child", plan: "family" });
    member = await joinHousehold(owner, "member");
    child = await joinHousehold(owner, "child");
  });

  it("can't download the household's data, but an owner and a member can", async () => {
    await expect(exportHouseholdData(child)).rejects.toThrow(/available|permission|adult/i);
    expect((await exportHouseholdData(owner)).format).toBe("plenty-export/1");
    expect((await exportHouseholdData(member)).format).toBe("plenty-export/1");
  });

  it("can't wipe or pause what the household has learned", async () => {
    const [id] = await addItems(owner, [{ name: "Milk" }]);
    await finishItem(owner, id, "consumed");
    const [row] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    const learned = () => systemDb.select().from(consumptionEvents).where(and(eq(consumptionEvents.householdId, owner.household.id), eq(consumptionEvents.productId, row.productId!)));
    const before = (await learned()).length;
    expect(before).toBeGreaterThan(0);
    await expect(resetProductLearning(child, row.productId!)).rejects.toThrow(/only change its own|permission/i);
    await expect(setPredictionsPaused(child, row.productId!, true)).rejects.toThrow(/only change its own|permission/i);
    expect((await learned()).length).toBe(before);
    // An adult still can.
    await expect(resetProductLearning(member, row.productId!)).resolves.toBeUndefined();
  });

  it("can't hand out or revoke invitations; the refusal says so instead of pretending", async () => {
    await expect(createInvitation(child)).rejects.toThrow(/owner/i);
    await expect(revokeInvitations(child)).rejects.toThrow(/owner/i);
    await expect(createInvitation(member)).rejects.toThrow(/owner/i);
    await expect(revokeInvitations(member)).rejects.toThrow(/owner/i);
  });
});

describe("taking over a housemate's things", () => {
  it("a housemate can't make someone else's shared item private to themselves", async () => {
    const alex = await makeHousehold({ name: "Item takeover", plan: "family" });
    const jordan = await joinHousehold(alex, "member");
    const [id] = await addItems(alex, [{ name: "Alex's cheese", ownerMemberId: alex.member.id }]);
    await expect(updateItem(jordan, id, { ownerMemberId: jordan.member.id, visibility: "private" })).rejects.toThrow(/someone else|only/i);
    const [row] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    expect(row.ownerMemberId).toBe(alex.member.id);
    expect(row.visibility).toBe("household");
    // The owner can still make their own item private.
    await expect(updateItem(alex, id, { visibility: "private" })).resolves.toBeUndefined();
  });
});

describe("moving between households", () => {
  it("switching to a household you aren't in changes nothing and says it couldn't be found", async () => {
    const a = await makeHousehold({ name: "Switch A" });
    const b = await makeHousehold({ name: "Switch B" });
    await expect(switchHousehold(a.user, b.household.id)).rejects.toThrow(/couldn't be found/i);
    // Same answer for one that doesn't exist at all, so the answer can't be used to find households.
    await expect(switchHousehold(a.user, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/couldn't be found/i);
    const ctx = await buildHouseholdContext({ ...a.user, activeHouseholdId: b.household.id });
    expect(ctx?.household.id).toBe(a.household.id);
  });
});

describe("leaving a household", () => {
  it("what the person shared stays with the household, including their regular purchases", async () => {
    const owner = await makeHousehold({ name: "Recurring stays", plan: "family" });
    const leaver = await joinHousehold(owner, "member");
    await createRecurring(leaver, { name: "Leaver's weekly yoghurt", intervalDays: 7, ownerMemberId: leaver.member.id });
    await createRecurring(leaver, { name: "Leaver's secret biscuits", intervalDays: 7, ownerMemberId: leaver.member.id, visibility: "private" });
    await removeMember(owner, leaver.member.id);
    const left = await systemDb.select().from(recurringItems).where(eq(recurringItems.householdId, owner.household.id));
    expect(left.map((r) => r.name)).toEqual(["Leaver's weekly yoghurt"]);
    expect(left[0].ownerMemberId).toBeNull();
  });
});

describe("what a child account sees and records", () => {
  it("doesn't see what was paid for things, and an adult does", async () => {
    const owner = await makeHousehold({ name: "Prices", plan: "family" });
    const child = await joinHousehold(owner, "child");
    const [id] = await addItems(owner, [{ name: "Expensive cheese", price: 19.5 }]);
    const asOwner = (await getInventory(owner)).items.find((i) => i.id === id);
    const asChild = (await getInventory(child)).items.find((i) => i.id === id);
    expect(asOwner?.price).toBe(19.5);
    expect(asChild).toBeDefined();
    expect(asChild?.price).toBeNull();
    expect((await getInventoryItem(child, id))?.item.price ?? null).toBeNull();
  });

  it("answering a check-in about the household's things changes nothing and records nothing", async () => {
    const owner = await makeHousehold({ name: "Check-in", plan: "family" });
    const child = await joinHousehold(owner, "child");
    const [id] = await addItems(owner, [{ name: "Rice", remainingFraction: 0.01 }]);
    const [item] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    const events = () => systemDb.select().from(inventoryEvents).where(eq(inventoryEvents.inventoryItemId, id));
    const before = (await events()).length;
    await answerCheckIn(child, item.productId!, false);
    await answerCheckIn(child, item.productId!, true);
    const [after] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    expect(after.status).toBe("active");
    expect(after.remainingFraction).toBe(item.remainingFraction);
    expect((await events()).length).toBe(before);
  });
});

describe("settings are for adults", () => {
  it("a child can't rename the household or change its preferences, and is told so rather than shown a success", async () => {
    const owner = await makeHousehold({ name: "Settings", plan: "family" });
    const child = await joinHousehold(owner, "child");
    await expect(updateHouseholdBasics(child, { name: "Hacked", adults: 1, children: 1 })).rejects.toThrow(/owner or a member/i);
    await expect(updatePreferences(child, { weeklyBudget: 1 })).rejects.toThrow(/owner or a member/i);
    const [h] = await systemDb.select().from(households).where(eq(households.id, owner.household.id));
    expect(h.name).toBe("Settings");
    // A member still can.
    const member = await joinHousehold(owner, "member");
    await expect(updatePreferences(member, { weeklyBudget: 150 })).resolves.toBeUndefined();
  });
});

describe("plan limits can't be skipped through the receipt", () => {
  it("a free household at its kitchen limit can't add more by confirming a receipt, and nothing is lost when it can't", async () => {
    const free = await makeHousehold({ name: "Free and full", plan: "free" });
    await systemDb.insert(inventoryItems).values(Array.from({ length: 49 }, (_, i) => ({ householdId: free.household.id, name: `Synthetic item ${i}`, quantity: 1 })));
    const [r] = await systemDb
      .insert(receipts)
      .values({ householdId: free.household.id, uploadedBy: free.user.id, status: "needs_review", storeName: "Shop", purchasedAt: new Date() })
      .returning();
    const rows = await systemDb
      .insert(receiptItems)
      .values(
        ["Bread", "Butter", "Jam"].map((name, i) => ({
          receiptId: r.id,
          householdId: free.household.id,
          lineIndex: i,
          rawText: name.toUpperCase(),
          name,
          aisle: "pantry" as const,
          location: "pantry" as const,
          quantity: 1,
          unit: "each" as const,
          packCount: 1,
          matchConfidence: 0.9,
          isFood: true,
          status: "pending" as const,
        })),
      )
      .returning();
    const line = (row: (typeof rows)[number], include = true) => ({
      id: row.id, include, name: row.name, productId: null, quantity: 1, unit: "each" as const, packCount: 1, location: "pantry" as const, existingDecision: null,
    });
    // Three more would make 52.
    await expect(confirmReceipt(free, r.id, { storeName: "Shop", purchasedOn: null, items: rows.map((row) => line(row)) })).rejects.toThrow(/room for 1 more|full on this plan/i);
    const [still] = await systemDb.select().from(receipts).where(eq(receipts.id, r.id));
    expect(still.status).toBe("needs_review");
    // One line fits (50 in total); skipping the rest is always allowed.
    await expect(confirmReceipt(free, r.id, { storeName: "Shop", purchasedOn: null, items: rows.map((row, i) => line(row, i === 0)) })).resolves.toMatchObject({ added: 1 });
  });
});
