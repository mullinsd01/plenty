import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pool, systemDb, withUser } from "@/server/db/client";
import { inventoryItems, products } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";
import { addItems } from "@/server/services/inventory";
import { inferContains, loadProductIndex } from "@/server/services/products";
import { makeHousehold } from "../helpers/db";

describe("things Plenty has no catalog entry for", () => {
  let ctx: HouseholdContext;

  beforeAll(async () => {
    ctx = await makeHousehold();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("guesses what's in them from the name, erring towards flagging", async () => {
    const index = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
    expect(inferContains("Almond croissant", index)).toEqual(expect.arrayContaining(["tree_nuts", "gluten"]));
    expect(inferContains("Satay peanut dipping sauce")).toContain("peanuts");
    expect(inferContains("Prawn gyoza")).toEqual(expect.arrayContaining(["shellfish", "gluten"]));
    expect(inferContains("Nonna's sugo")).toEqual([]);
  });

  it("new household products carry those flags, so allergy rules still apply", async () => {
    const [id] = await addItems(ctx, [{ name: "Grandma's almond biscotti" }]);
    const [item] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, id));
    const [product] = await systemDb.select().from(products).where(eq(products.id, item.productId!));
    expect(product.householdId).toBe(ctx.household.id);
    expect(product.contains).toEqual(expect.arrayContaining(["tree_nuts", "gluten"]));
  });
});
