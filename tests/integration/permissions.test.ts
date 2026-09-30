import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { pool, systemDb, withUser } from "@/server/db/client";
import { householdMembers, inventoryItems, notifications, sessions, shoppingListItems } from "@/server/db/schema";
import { acceptInvitation, createInvitation, removeMember } from "@/server/services/household";
import { addItems, getInventory, removeItem, setLevel } from "@/server/services/inventory";
import { addManualItem, getShoppingList } from "@/server/services/shopping";
import { search } from "@/server/services/search";
import type { HouseholdContext } from "@/server/auth/context";
import { makeHousehold } from "../helpers/db";

describe("household isolation (permissions + row-level security)", () => {
  let a: HouseholdContext;
  let b: HouseholdContext;
  let bItemId: string;

  beforeAll(async () => {
    a = await makeHousehold({ name: "Household A" });
    b = await makeHousehold({ name: "Household B" });
    await addItems(a, [{ name: "Milk" }, { name: "Bread" }]);
    [bItemId] = await addItems(b, [{ name: "Secret salmon" }]);
    await addManualItem(b, { name: "B's list item" });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("services only ever return the caller's own household data", async () => {
    const inv = await getInventory(a);
    expect(inv.items.map((i) => i.name).sort()).toEqual(expect.arrayContaining(["Milk", "Bread"]));
    expect(inv.items.some((i) => i.name === "Secret salmon")).toBe(false);
    const list = await getShoppingList(a);
    expect(list.items.some((i) => i.name === "B's list item")).toBe(false);
    const results = await search(a, "salmon");
    expect(results.inventory).toHaveLength(0);
  });

  it("RLS hides other households even when a query forgets its WHERE clause", async () => {
    const rows = await withUser(a.user.id, (tx) => tx.select({ name: inventoryItems.name }).from(inventoryItems));
    expect(rows.map((r) => r.name)).not.toContain("Secret salmon");
    const directly = await withUser(a.user.id, (tx) => tx.select().from(inventoryItems).where(eq(inventoryItems.id, bItemId)));
    expect(directly).toHaveLength(0);
  });

  it("RLS rejects writes into another household", async () => {
    await expect(
      withUser(a.user.id, (tx) => tx.insert(inventoryItems).values({ householdId: b.household.id, name: "Intruder", quantity: 1 })),
    ).rejects.toThrow();
    const updated = await withUser(a.user.id, (tx) =>
      tx.update(inventoryItems).set({ name: "Hacked" }).where(eq(inventoryItems.id, bItemId)).returning(),
    );
    expect(updated).toHaveLength(0);
    const [still] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, bItemId));
    expect(still.name).toBe("Secret salmon");
  });

  it("services refuse to act on another household's items", async () => {
    await expect(setLevel(a, bItemId, 0.5)).rejects.toThrow(/couldn't be found/);
    await expect(removeItem(a, bItemId)).rejects.toThrow(/couldn't be found/);
  });

  it("auth tables are completely inaccessible to the app role", async () => {
    await expect(withUser(a.user.id, (tx) => tx.select().from(sessions))).rejects.toThrow(/permission denied/);
  });

  it("notifications are private to each member", async () => {
    await systemDb.insert(notifications).values({
      householdId: b.household.id,
      userId: b.user.id,
      type: "insight",
      title: "B only",
      body: "x",
      dedupeKey: "test:b-only",
    });
    const visible = await withUser(a.user.id, (tx) => tx.select().from(notifications));
    expect(visible.some((n) => n.title === "B only")).toBe(false);
  });

  it("an invitation grants shared access, and removal revokes it", async () => {
    const invite = await createInvitation(b);
    await acceptInvitation(a.user, invite.code);
    // A now sees B's kitchen through RLS.
    const shared = await withUser(a.user.id, (tx) =>
      tx.select({ name: inventoryItems.name }).from(inventoryItems).where(eq(inventoryItems.householdId, b.household.id)),
    );
    expect(shared.map((r) => r.name)).toContain("Secret salmon");
    // B's list is visible to A as a member of B.
    const list = await withUser(a.user.id, (tx) =>
      tx.select().from(shoppingListItems).where(eq(shoppingListItems.householdId, b.household.id)),
    );
    expect(list.length).toBeGreaterThan(0);

    await removeMember(b, a.user.id);
    const after = await withUser(a.user.id, (tx) =>
      tx.select({ n: sql<number>`count(*)` }).from(inventoryItems).where(eq(inventoryItems.householdId, b.household.id)),
    );
    expect(Number(after[0].n)).toBe(0);
    const membership = await systemDb.select().from(householdMembers).where(eq(householdMembers.userId, a.user.id));
    expect(membership.map((m) => m.householdId)).not.toContain(b.household.id);
  });

  it("members can't escalate themselves into another household", async () => {
    await expect(
      withUser(a.user.id, (tx) => tx.insert(householdMembers).values({ householdId: b.household.id, userId: a.user.id, role: "owner" })),
    ).rejects.toThrow();
  });
});
