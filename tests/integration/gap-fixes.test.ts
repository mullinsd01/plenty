/**
 * Regression tests for the gaps found after the first full build: private names that could leak through
 * products and receipts, reporting an AI-written recipe, and secrets the app's database role must not read.
 */
import { afterAll, describe, expect, it } from "vitest";
import { entitlementsFor } from "@/lib/billing/plans";
import { countActiveItems } from "@/server/billing/entitlements";
import { and, eq } from "drizzle-orm";
import { pool, systemDb, withUser } from "@/server/db/client";
import {
  contentReports,
  inventoryItems,
  mealIngredients,
  meals,
  productAliases,
  products,
  receiptItems,
  receipts,
  users,
} from "@/server/db/schema";
import { buildHouseholdContext, type HouseholdContext } from "@/server/auth/build-context";
import { acceptInvitation, createInvitation } from "@/server/services/household";
import { addItems, addItemsTx, finishItem, restoreItem, updateItem } from "@/server/services/inventory";
import { updateMember } from "@/server/services/members";
import { reportRecipe } from "@/server/services/meals";
import { confirmReceipt } from "@/server/services/receipts";
import { householdNameFor } from "@/server/services/learning";
import { makeHousehold } from "../helpers/db";

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

const productNamesSeenBy = async (viewer: HouseholdContext) =>
  (await withUser(viewer.user.id, (tx) => tx.select({ name: products.name }).from(products).where(eq(products.householdId, viewer.household.id)))).map((p) => p.name);

afterAll(async () => {
  await pool.end();
});

describe("a private item's product name is private too", () => {
  it("is visible to its owner and nobody else in the household, and becomes visible when the item is shared", async () => {
    const alex = await makeHousehold({ name: "Private products", plan: "family" });
    const jordan = await joinHousehold(alex);
    const [id] = await addItems(alex, [{ name: "Quinoa crisps", ownerMemberId: alex.member.id, visibility: "private" }]);

    expect(await productNamesSeenBy(alex)).toContain("Quinoa crisps");
    expect(await productNamesSeenBy(jordan)).not.toContain("Quinoa crisps");

    await updateItem(alex, id, { ownerMemberId: null });
    expect(await productNamesSeenBy(jordan)).toContain("Quinoa crisps");
  });

  it("doesn't get in the way of someone else adding the same thing for the household", async () => {
    const alex = await makeHousehold({ name: "Same name", plan: "family" });
    const jordan = await joinHousehold(alex);
    const [mine] = await addItems(alex, [{ name: "Nori snacks", ownerMemberId: alex.member.id, visibility: "private" }]);
    // Jordan can't see Alex's product, so this makes a separate shared one rather than failing on the name.
    await addItems(jordan, [{ name: "Nori snacks" }]);
    expect((await productNamesSeenBy(jordan)).filter((n) => n === "Nori snacks")).toHaveLength(1);
    // Alex sharing hers joins the product the household already has instead of making a duplicate.
    await updateItem(alex, mine, { ownerMemberId: null });
    const [row] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, mine));
    const [product] = await systemDb.select().from(products).where(eq(products.id, row.productId!));
    expect(product.ownerMemberId).toBeNull();
    expect(await systemDb.select().from(products).where(and(eq(products.householdId, alex.household.id), eq(products.name, "Nori snacks")))).toHaveLength(2);
  });

  it("reuses a product the household already shares: a private item with a shared name hides nothing", async () => {
    const alex = await makeHousehold({ name: "Reuse shared", plan: "family" });
    await addItems(alex, [{ name: "Chilli crisps" }]);
    await addItems(alex, [{ name: "Chilli crisps", ownerMemberId: alex.member.id, visibility: "private" }]);
    const rows = await systemDb.select().from(products).where(and(eq(products.householdId, alex.household.id), eq(products.name, "Chilli crisps")));
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerMemberId).toBeNull();
  });
});

describe("a private receipt line leaves nothing readable behind", () => {
  it("other adults see an unnamed, unpriced line and no remembered alias; shared lines are untouched", async () => {
    const alex = await makeHousehold({ name: "Private lines", plan: "family" });
    const jordan = await joinHousehold(alex);
    const [r] = await systemDb
      .insert(receipts)
      .values({ householdId: alex.household.id, uploadedBy: alex.user.id, status: "needs_review", storeName: "Shop", purchasedAt: new Date() })
      .returning();
    const line = (lineIndex: number, rawText: string, name: string) => ({
      receiptId: r.id,
      householdId: alex.household.id,
      lineIndex,
      rawText,
      name,
      aisle: "pantry" as const,
      location: "pantry" as const,
      quantity: 1,
      unit: "each" as const,
      packCount: 1,
      unitPrice: 4.5,
      totalPrice: 4.5,
      matchConfidence: 0.9,
      isFood: true,
      status: "pending" as const,
    });
    const [secret, shared] = await systemDb.insert(receiptItems).values([line(0, "SECRET STASH BAR", "Secret stash bar"), line(1, "RICE CRACKERS", "Rice crackers")]).returning();
    const decision = (id: string, name: string, owned: boolean) => ({
      id,
      include: true,
      name,
      productId: null,
      quantity: 1,
      unit: "each" as const,
      packCount: 1,
      location: "pantry" as const,
      existingDecision: null,
      ...(owned ? { ownerMemberId: alex.member.id, visibility: "private" as const } : {}),
    });
    await confirmReceipt(alex, r.id, { storeName: "Shop", purchasedOn: null, items: [decision(secret.id, "Secret stash bar", true), decision(shared.id, "Rice crackers", false)] });

    const seen = await withUser(jordan.user.id, (tx) => tx.select().from(receiptItems).where(eq(receiptItems.receiptId, r.id)));
    const hidden = seen.find((l) => l.id === secret.id)!;
    expect(hidden).toMatchObject({ name: "Private item", rawText: "Private item", productId: null, inventoryItemId: null, totalPrice: null, unitPrice: null, status: "accepted" });
    expect(JSON.stringify(seen)).not.toMatch(/secret stash/i);
    expect(seen.find((l) => l.id === shared.id)).toMatchObject({ name: "Rice crackers", totalPrice: 4.5 });

    const aliases = await systemDb.select().from(productAliases).where(eq(productAliases.householdId, alex.household.id));
    expect(aliases.map((a) => a.aliasKey).join(" ")).not.toMatch(/secret|stash/);
    // Her own item is still in her kitchen, private, with its price.
    const [item] = await systemDb.select().from(inventoryItems).where(and(eq(inventoryItems.householdId, alex.household.id), eq(inventoryItems.name, "Secret stash bar")));
    expect(item).toMatchObject({ visibility: "private", ownerMemberId: alex.member.id });
    expect(item.price).toBe(4.5);
  });
});

describe("reporting an AI-written recipe", () => {
  async function aiRecipe(ctx: HouseholdContext, source: "ai" | "user" | "library" = "ai") {
    const [meal] = await systemDb
      .insert(meals)
      .values({ householdId: ctx.household.id, source, slug: `r-${Math.random().toString(36).slice(2)}`, name: "Pan-fried chicken", description: "Quick dinner", timeMinutes: 20, steps: ["Fry the chicken", "Serve"] })
      .returning();
    await systemDb.insert(mealIngredients).values({ mealId: meal.id, householdId: ctx.household.id, position: 0, name: "Chicken thighs", quantity: 500, unit: "g" });
    return meal;
  }

  it("stores the report with the recipe as it was, readable only by whoever filed it", async () => {
    const alex = await makeHousehold({ name: "Reports", plan: "family" });
    const jordan = await joinHousehold(alex);
    const meal = await aiRecipe(alex);
    await reportRecipe(alex, meal.id, "unsafe", "  Says to cook it for five minutes  ");
    const [report] = await systemDb.select().from(contentReports).where(eq(contentReports.householdId, alex.household.id));
    expect(report).toMatchObject({ reason: "unsafe", note: "Says to cook it for five minutes", mealName: "Pan-fried chicken", reporterUserId: alex.user.id });
    expect(report.mealSnapshot).toMatch(/Chicken thighs/);
    expect(report.mealSnapshot).toMatch(/1\. Fry the chicken/);
    expect(await withUser(alex.user.id, (tx) => tx.select().from(contentReports))).toHaveLength(1);
    expect(await withUser(jordan.user.id, (tx) => tx.select().from(contentReports))).toHaveLength(0);
  });

  it("is only for AI-written recipes, only for adults, and only with a real reason", async () => {
    const alex = await makeHousehold({ name: "Report limits", plan: "family" });
    const child = await joinHousehold(alex, "child");
    await expect(reportRecipe(alex, (await aiRecipe(alex, "user")).id, "other")).rejects.toThrow(/written by AI/);
    await expect(reportRecipe(child, (await aiRecipe(alex)).id, "other")).rejects.toThrow();
    await expect(reportRecipe(alex, (await aiRecipe(alex)).id, "spam" as never)).rejects.toThrow();
    expect(await systemDb.select().from(contentReports).where(eq(contentReports.householdId, alex.household.id))).toHaveLength(0);
  });

  it("can't be filed against another household's recipe", async () => {
    const alex = await makeHousehold({ name: "Mine", plan: "family" });
    const stranger = await makeHousehold({ name: "Theirs", plan: "family" });
    await expect(reportRecipe(stranger, (await aiRecipe(alex)).id, "other")).rejects.toThrow(/couldn.t be found|not found|find/i);
  });
});

describe("secrets the app's database role can't read", () => {
  it("never reads a password hash, not even its own", async () => {
    const alex = await makeHousehold({ name: "Hashes", plan: "family" });
    await expect(withUser(alex.user.id, (tx) => tx.select({ hash: users.passwordHash }).from(users))).rejects.toThrow();
    await expect(withUser(alex.user.id, (tx) => tx.select().from(users).where(eq(users.id, alex.user.id)))).rejects.toThrow();
    const [self] = await withUser(alex.user.id, (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, alex.user.id)));
    expect(self.email).toBe(alex.user.email);
  });
});

describe("what a household calls things", () => {
  it("is the name on its most recent item, falling back to the catalogue's", () => {
    const product = { name: "Diet cola" } as never;
    const item = (name: string) => ({ name }) as never;
    expect(householdNameFor({ product, items: [item("Coke Zero"), item("Pepsi Max")] })).toBe("Pepsi Max");
    expect(householdNameFor({ product, items: [item("Pepsi Max"), item("  ")] })).toBe("Pepsi Max");
    expect(householdNameFor({ product, items: [] })).toBe("Diet cola");
  });
});

describe("scanned items aren't fuzzy-matched to the wrong catalogue entry", () => {
  it("'Protein bars' is its own thing, not muesli bars", async () => {
    const alex = await makeHousehold({ name: "Scans", plan: "family" });
    const [item] = await withUser(alex.user.id, (tx) => addItemsTx(tx, alex.household, alex.user.id, [{ name: "Protein bars" }], "barcode", new Date()));
    const [product] = await systemDb.select().from(products).where(eq(products.id, item.productId!));
    expect(product.slug).not.toBe("muesli-bars");
    expect(product.name).toBe("Protein bars");
  });
});

describe("the kitchen's size limit holds when people add at the same moment", () => {
  const limit = entitlementsFor("free").max_inventory_items!;

  async function fillToOneShort() {
    const ctx = await makeHousehold({ name: "Racing", plan: "free" });
    const jordan = await joinHousehold(ctx);
    const jordanFree = { ...jordan, plan: ctx.plan };
    // Half of the full kitchen is the owner's private items, which the other person can't see but which still count.
    const privateCount = Math.floor((limit - 1) / 2);
    await systemDb
      .insert(inventoryItems)
      .values(Array.from({ length: privateCount }, (_, n) => ({ householdId: ctx.household.id, name: `Private staple ${n}`, quantity: 1, ownerMemberId: ctx.member.id, visibility: "private" as const })));
    await addItems(ctx, Array.from({ length: limit - 1 - privateCount }, (_, n) => ({ name: `Staple number ${n}` })));
    return { ctx, jordan: jordanFree };
  }

  it("lets exactly one of several simultaneous adds take the last place, private items included in the count", async () => {
    const { ctx, jordan } = await fillToOneShort();
    const attempts = await Promise.allSettled([
      addItems(ctx, [{ name: "Race one" }]),
      addItems(jordan, [{ name: "Race two" }]),
      addItems(ctx, [{ name: "Race three" }]),
      addItems(jordan, [{ name: "Race four" }]),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected").every((a) => /full|room/i.test(String((a as PromiseRejectedResult).reason?.message)))).toBe(true);
    expect(await countActiveItems(ctx.household.id)).toBe(limit);
  });

  it("won't let something be brought back into a full kitchen", async () => {
    const { ctx } = await fillToOneShort();
    const [gone] = await addItems(ctx, [{ name: "Finished thing" }]);
    await finishItem(ctx, gone, "consumed");
    await addItems(ctx, [{ name: "Took its place" }]);
    expect(await countActiveItems(ctx.household.id)).toBe(limit);
    await expect(restoreItem(ctx, gone)).rejects.toThrow(/full/i);
    expect(await countActiveItems(ctx.household.id)).toBe(limit);
  });
});
