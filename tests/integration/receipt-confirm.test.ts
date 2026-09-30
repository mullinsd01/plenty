import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { aliasKey } from "@/lib/normalize";
import { addDays, toDateString, zonedDateTimeToInstant } from "@/lib/dates";
import { pool, systemDb, withUser } from "@/server/db/client";
import { productAliases, receiptItems, receipts, shoppingListItems } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";
import { loadProductIndex } from "@/server/services/products";
import { confirmReceipt } from "@/server/services/receipts";
import { addManualItem, getShoppingList } from "@/server/services/shopping";
import { makeHousehold } from "../helpers/db";

/**
 * Confirming receipts without OCR: receipts and their lines are inserted as if
 * they had just been read, then confirmed through the real service.
 */
describe("confirming a receipt", () => {
  let ctx: HouseholdContext;
  let productIdBySlug: (slug: string) => string;

  beforeAll(async () => {
    ctx = await makeHousehold();
    const index = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
    productIdBySlug = (slug) => index.bySlug.get(slug)!.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function readReceipt(purchasedOn: string, lines: Array<{ raw: string; name: string; slug: string | null; confidence: number }>) {
    const [r] = await systemDb
      .insert(receipts)
      .values({
        householdId: ctx.household.id,
        uploadedBy: ctx.user.id,
        status: "needs_review",
        storeName: "Woolworths",
        purchasedAt: zonedDateTimeToInstant(purchasedOn, 12, ctx.household.timezone),
      })
      .returning();
    const rows = await systemDb
      .insert(receiptItems)
      .values(
        lines.map((l, i) => ({
          receiptId: r.id,
          householdId: ctx.household.id,
          lineIndex: i,
          rawText: l.raw,
          name: l.name,
          productId: l.slug ? productIdBySlug(l.slug) : null,
          aisle: "pantry" as const,
          location: "pantry" as const,
          quantity: 1,
          unit: "each" as const,
          packCount: 1,
          matchConfidence: l.confidence,
          isFood: true,
          status: "pending" as const,
        })),
      )
      .returning();
    return { receipt: r, rows };
  }

  const confirmAll = (receiptId: string, purchasedOn: string, rows: Array<typeof receiptItems.$inferSelect>, overrides: Record<string, Partial<{ name: string; productId: string | null }>> = {}) =>
    confirmReceipt(ctx, receiptId, {
      storeName: "Woolworths",
      purchasedOn,
      items: rows.map((row) => ({
        id: row.id,
        include: true,
        name: overrides[row.id]?.name ?? row.name,
        productId: overrides[row.id]?.productId !== undefined ? overrides[row.id]!.productId! : row.productId,
        quantity: 1,
        unit: "each",
        packCount: 1,
        location: "pantry",
        existingDecision: null,
      })),
    });

  it("an older receipt doesn't tick off things added to the list after that shop", async () => {
    const today = toDateString(new Date(), ctx.household.timezone);
    await addManualItem(ctx, { name: "Honey" });
    const { receipt, rows } = await readReceipt(addDays(today, -4), [{ raw: "CAPILANO HONEY 500G", name: "Honey", slug: "honey", confidence: 0.95 }]);
    const result = await confirmAll(receipt.id, addDays(today, -4), rows);
    expect(result.tickedOff).toBe(0);
    const list = await getShoppingList(ctx);
    expect(list.items.some((i) => i.name === "Honey")).toBe(true);
  });

  it("today's receipt ticks off what was on the list", async () => {
    const today = toDateString(new Date(), ctx.household.timezone);
    const { receipt, rows } = await readReceipt(today, [{ raw: "CAPILANO HONEY 500G", name: "Honey", slug: "honey", confidence: 0.95 }]);
    const result = await confirmAll(receipt.id, today, rows);
    expect(result.tickedOff).toBe(1);
    const open = await systemDb
      .select()
      .from(shoppingListItems)
      .where(and(eq(shoppingListItems.householdId, ctx.household.id), eq(shoppingListItems.name, "Honey")));
    expect(open).toHaveLength(0);
  });

  it("remembers corrections and confident matches, but not unsure guesses nobody checked", async () => {
    const today = toDateString(new Date(), ctx.household.timezone);
    const { receipt, rows } = await readReceipt(today, [
      // An unsure guess the household didn't touch: not remembered.
      { raw: "MYSTERY SPREAD 250G", name: "Peanut butter", slug: "peanut-butter", confidence: 0.6 },
      // A confident match: remembered.
      { raw: "WW PLAIN FLOUR 1KG", name: "Plain flour", slug: "plain-flour", confidence: 0.92 },
      // An unmatched line the household named: remembered as their own product.
      { raw: "NONNA SUGO CLASSICO", name: "Nonna sugo classico", slug: null, confidence: 0 },
    ]);
    await confirmAll(receipt.id, today, rows, { [rows[2].id]: { name: "Pasta sauce" } });
    const aliases = await systemDb.select().from(productAliases).where(eq(productAliases.householdId, ctx.household.id));
    const keys = new Set(aliases.map((a) => a.aliasKey));
    expect(keys.has(aliasKey("MYSTERY SPREAD 250G"))).toBe(false);
    expect(keys.has(aliasKey("WW PLAIN FLOUR 1KG"))).toBe(true);
    expect(keys.has(aliasKey("NONNA SUGO CLASSICO"))).toBe(true);
  });

  it("refuses a receipt that isn't waiting for review", async () => {
    const today = toDateString(new Date(), ctx.household.timezone);
    const { receipt, rows } = await readReceipt(today, [{ raw: "WW PLAIN FLOUR 1KG", name: "Plain flour", slug: "plain-flour", confidence: 0.92 }]);
    await confirmAll(receipt.id, today, rows);
    await expect(confirmAll(receipt.id, today, rows)).rejects.toThrow(/already/);
  });
});
