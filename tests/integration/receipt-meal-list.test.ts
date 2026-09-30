import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { toDateString } from "@/lib/dates";
import { normalizeReceiptLine } from "@/lib/normalize";
import { pool, systemDb, withUser } from "@/server/db/client";
import { consumptionEvents, inventoryEvents, inventoryItems, mealPlanItems, receipts, shoppingListItems } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";
import { terminateOcrWorker } from "@/server/receipts/ocr";
import { addItems, getInventory } from "@/server/services/inventory";
import { generateMealPlan, getMealPlan, markPlanItemCooked, whatCanIMake } from "@/server/services/meals";
import { loadProductIndex, matchOptions } from "@/server/services/products";
import { confirmReceipt, createReceiptFromUpload, getReceiptReview, processReceipt } from "@/server/services/receipts";
import { addManualItem, getShoppingList, removeShoppingItem, syncShoppingList } from "@/server/services/shopping";
import { makeHousehold } from "../helpers/db";

const FIXTURES = path.join(process.cwd(), "tests/fixtures/receipts");
const DAY = 86_400_000;

describe("receipt → kitchen → meal plan → shopping list", () => {
  let ctx: HouseholdContext;
  let receiptId: string;
  let oldMilkId: string;

  beforeAll(async () => {
    ctx = await makeHousehold({ adults: 2, children: 1 });
    // Milk bought a few days ago that's probably nearly gone.
    [oldMilkId] = await addItems(ctx, [{ name: "Full cream milk" }]);
    await systemDb
      .update(inventoryItems)
      .set({ purchasedAt: new Date(Date.now() - 5 * DAY), levelUpdatedAt: new Date(Date.now() - 5 * DAY) })
      .where(eq(inventoryItems.id, oldMilkId));
    await addManualItem(ctx, { name: "Milk" });
  });

  afterAll(async () => {
    await terminateOcrWorker();
    await pool.end();
  });

  it("reads a receipt photo on-device and prepares it for review", async () => {
    const bytes = await readFile(path.join(FIXTURES, "woolworths-weekly.png"));
    const upload = await createReceiptFromUpload(ctx, { bytes, size: bytes.length });
    expect(upload.duplicateOf).toBeNull();
    receiptId = upload.receiptId;
    await processReceipt(ctx.user.id, ctx.household, receiptId);
    const review = await getReceiptReview(ctx, receiptId);
    expect(review?.status).toBe("needs_review");
    const names = review!.items.map((i) => i.productName ?? i.name).join(" | ").toLowerCase();
    expect(names).toContain("milk");
    expect(names).toMatch(/bread/);
    expect(names).toMatch(/egg/);
    // The carry bag is recognised as non-grocery and left out by default.
    const bag = review!.items.find((i) => /bag/i.test(i.rawText));
    if (bag) expect(bag.status).toBe("ignored");
    // Plenty noticed the older milk and suggests it's finished.
    const milk = review!.items.find((i) => i.productName?.toLowerCase().includes("milk"));
    expect(milk?.existing?.suggestion).toBe("replace");
  }, 150_000);

  it("detects the same photo being uploaded twice", async () => {
    const bytes = await readFile(path.join(FIXTURES, "woolworths-weekly.png"));
    const again = await createReceiptFromUpload(ctx, { bytes, size: bytes.length });
    expect(again.duplicateOf?.id).toBe(receiptId);
  });

  it("confirming fills the kitchen, closes the old batch, ticks off the list and learns corrections", async () => {
    const review = (await getReceiptReview(ctx, receiptId))!;
    const index = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
    const lite = [...index.bySlug.values()].find((p) => p.slug === "lite-milk")!;
    const milkLine = review.items.find((i) => i.productName?.toLowerCase().includes("milk"))!;
    const result = await confirmReceipt(ctx, receiptId, {
      storeName: review.storeName,
      // Today's shop: list items added before it count as bought (an older receipt wouldn't tick off
      // things added to the list after that shop).
      purchasedOn: toDateString(new Date(), ctx.household.timezone),
      items: review.items.map((i) => ({
        id: i.id,
        include: i.status !== "ignored",
        // The household corrects the milk: it was actually lite milk.
        name: i.id === milkLine.id ? lite.name : i.name,
        productId: i.id === milkLine.id ? lite.id : i.productId,
        quantity: i.quantity,
        unit: i.unit,
        packCount: i.packCount,
        location: i.location,
        existingDecision: i.existing ? i.existing.suggestion : null,
      })),
    });
    expect(result.added).toBeGreaterThan(8);

    // The old milk was closed off as finished → a learning observation.
    const [old] = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.id, oldMilkId));
    expect(old.status).toBe("finished");
    const obs = await systemDb.select().from(consumptionEvents).where(eq(consumptionEvents.inventoryItemId, oldMilkId));
    expect(obs).toHaveLength(1);

    // "Milk" on the list was bought.
    const list = await getShoppingList(ctx);
    expect(list.items.some((i) => i.source === "manual" && /milk/i.test(i.name))).toBe(false);
    expect(result.tickedOff).toBeGreaterThan(0);

    const [receipt] = await systemDb.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(receipt.status).toBe("confirmed");

    // Next time, the same receipt text maps to lite milk for this household.
    const index2 = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
    const again = normalizeReceiptLine(milkLine.rawText, matchOptions(index2));
    expect(again.match?.product.slug).toBe("lite-milk");
  });

  it("can't confirm the same receipt twice", async () => {
    await expect(confirmReceipt(ctx, receiptId, { storeName: null, purchasedOn: null, items: [] })).rejects.toThrow(/already/);
  });

  it("plans meals from the kitchen and only lists what's missing", async () => {
    const r = await generateMealPlan(ctx, "3days");
    expect(r.planned).toBeGreaterThan(0);
    const plan = await getMealPlan(ctx);
    const planned = plan.days.filter((d) => d.item);
    expect(planned.length).toBe(r.planned);

    const list = await getShoppingList(ctx);
    const inventory = await getInventory(ctx);
    const planItems = list.items.filter((i) => i.sources.some((s) => s.source === "meal_plan"));
    for (const item of planItems) {
      expect(item.reason ?? "").toMatch(/For \w+'s /);
    }
    // Nothing that is fully stocked (full, not expiring) should be on the list purely for meals
    // unless the plan needs more than is at home — spot-check by product.
    const stocked = new Set(inventory.items.filter((i) => i.estimatedFraction > 0.95 && i.productId).map((i) => i.productId));
    const suspicious = planItems.filter((i) => i.productId && stocked.has(i.productId) && i.sources.every((s) => s.source === "meal_plan"));
    for (const s of suspicious) {
      // If it's on the list despite stock, there must be a stated shortfall quantity.
      expect(s.quantity ?? 0).toBeGreaterThan(0);
    }
  });

  it("removing an auto-added item keeps it off the list until the next shop", async () => {
    const list = await getShoppingList(ctx);
    const auto = list.items.find((i) => i.source !== "manual");
    if (!auto) return;
    await removeShoppingItem(ctx, auto.id);
    await withUser(ctx.user.id, (tx) => syncShoppingList(tx, ctx.household, new Date()));
    const after = await getShoppingList(ctx);
    expect(after.items.some((i) => i.id === auto.id)).toBe(false);
    const [row] = await systemDb.select().from(shoppingListItems).where(eq(shoppingListItems.id, auto.id));
    expect(row?.dismissedUntil).toBeTruthy();
  });

  it("cooking a planned meal takes its ingredients out of the kitchen", async () => {
    const plan = await getMealPlan(ctx);
    const first = plan.days.find((d) => d.item && d.item.status === "planned")!.item!;
    const res = await markPlanItemCooked(ctx, first.id);
    const [row] = await systemDb.select().from(mealPlanItems).where(eq(mealPlanItems.id, first.id));
    expect(row.status).toBe("cooked");
    if (res.usedItems > 0) {
      const events = await systemDb
        .select()
        .from(inventoryEvents)
        .where(and(eq(inventoryEvents.householdId, ctx.household.id), eq(inventoryEvents.mealPlanItemId, first.id)));
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.actor === "meal")).toBe(true);
    }
  });

  it("'What can I make?' ranks meals by what's on hand", async () => {
    const meals = await whatCanIMake(ctx);
    expect(meals.length).toBeGreaterThan(3);
    const missing = meals.map((m) => Math.min(m.missingCount, 3));
    const sorted = [...missing].sort((a, b) => a - b);
    expect(missing).toEqual(sorted);
  });

  it("keeps receipts in the household that uploaded them", async () => {
    const other = await makeHousehold();
    expect(await getReceiptReview(other, receiptId)).toBeNull();
    const rows = await withUser(other.user.id, (tx) => tx.select().from(receipts).where(inArray(receipts.id, [receiptId])));
    expect(rows).toHaveLength(0);
  });
});
