import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { pool, systemDb } from "@/server/db/client";
import { preferences, receiptItems, receipts } from "@/server/db/schema";
import type { HouseholdContext } from "@/server/auth/context";
import { loadProductIndex } from "@/server/services/products";
import { confirmReceipt, createReceiptFromUpload, discardReceipt, getReceiptReview, normalizeExtraction } from "@/server/services/receipts";
import { KEPT_IMAGE_DAYS, UNCHECKED_IMAGE_DAYS, deleteExpiredReceiptImages } from "@/server/services/receipt-privacy";
import { setReceiptImageRetention } from "@/server/services/privacy";
import { receiptImageKey, saveFile } from "@/server/storage/files";
import { withUser } from "@/server/db/client";
import { makeHousehold } from "../helpers/db";

const DAY = 86_400_000;
const STORAGE = path.resolve(process.cwd(), process.env.STORAGE_DIR ?? ".data/uploads");
const onDisk = (key: string | null) => (key ? existsSync(path.join(STORAGE, key)) : false);

describe("receipt photo retention", () => {
  let ctx: HouseholdContext;
  let milkId: string;

  beforeAll(async () => {
    ctx = await makeHousehold({ plan: "plus" });
    const index = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
    milkId = index.bySlug.get("full-cream-milk")!.id;
  });
  afterAll(async () => {
    await pool.end();
  });

  const setPolicy = (policy: "after_review" | "days_30" | "keep") =>
    systemDb.update(preferences).set({ receiptImageRetention: policy }).where(eq(preferences.householdId, ctx.household.id));

  /** A receipt that has been read and is waiting for review, with its photo on disk. */
  async function readReceipt() {
    const [r] = await systemDb
      .insert(receipts)
      .values({ householdId: ctx.household.id, uploadedBy: ctx.user.id, status: "needs_review", storeName: "Woolworths", purchasedAt: new Date() })
      .returning();
    const key = receiptImageKey(ctx.household.id, r.id);
    await saveFile(key, Buffer.from("not really a jpeg"));
    await systemDb.update(receipts).set({ imagePath: key, imageDeleteAfter: new Date(Date.now() + UNCHECKED_IMAGE_DAYS * DAY) }).where(eq(receipts.id, r.id));
    const [row] = await systemDb
      .insert(receiptItems)
      .values({ receiptId: r.id, householdId: ctx.household.id, lineIndex: 0, rawText: "WW FULL CREAM MILK 2L", name: "Full cream milk", productId: milkId, matchConfidence: 0.95, status: "pending" })
      .returning();
    return { id: r.id, key, itemId: row.id };
  }

  const confirm = (receiptId: string, itemId: string) =>
    confirmReceipt(ctx, receiptId, {
      storeName: "Woolworths",
      purchasedOn: null,
      items: [{ id: itemId, include: true, name: "Full cream milk", productId: milkId, quantity: 2, unit: "l", packCount: 1, location: "fridge", existingDecision: null }],
    });

  const load = async (id: string) => (await systemDb.select().from(receipts).where(eq(receipts.id, id)))[0];

  it("defaults to deleting the photo once the receipt is checked, and keeps the items", async () => {
    await setPolicy("after_review");
    const r = await readReceipt();
    expect(onDisk(r.key)).toBe(true);
    await confirm(r.id, r.itemId);
    const after = await load(r.id);
    expect(onDisk(r.key)).toBe(false);
    expect(after.imagePath).toBeNull();
    expect(after.imageDeletedAt).not.toBeNull();
    const items = await systemDb.select().from(receiptItems).where(eq(receiptItems.receiptId, r.id));
    expect(items.map((i) => i.status)).toEqual(["accepted"]);
    // The review page says so instead of failing.
    const review = await getReceiptReview(ctx, r.id);
    expect(review?.hasImage).toBe(false);
    expect(review?.imageDeleted).toBe(true);
  });

  it("keeps the photo for 30 days, then deletes it once that time has passed (now is injected)", async () => {
    await setPolicy("days_30");
    const r = await readReceipt();
    const before = Date.now();
    await confirm(r.id, r.itemId);
    const confirmed = await load(r.id);
    expect(onDisk(r.key)).toBe(true);
    expect(confirmed.imageDeleteAfter!.getTime()).toBeGreaterThanOrEqual(before + KEPT_IMAGE_DAYS * DAY - 5000);
    expect(confirmed.imageDeleteAfter!.getTime()).toBeLessThanOrEqual(Date.now() + KEPT_IMAGE_DAYS * DAY + 5000);

    // Day 29: nothing due for this receipt.
    await deleteExpiredReceiptImages(new Date(Date.now() + 29 * DAY), { receiptId: r.id });
    expect(onDisk(r.key)).toBe(true);
    expect((await load(r.id)).imageDeletedAt).toBeNull();

    // Day 31: gone, and the structured items remain.
    const result = await deleteExpiredReceiptImages(new Date(Date.now() + 31 * DAY), { receiptId: r.id });
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(onDisk(r.key)).toBe(false);
    const after = await load(r.id);
    expect(after.imagePath).toBeNull();
    expect(after.imageDeletedAt).not.toBeNull();
    expect((await systemDb.select().from(receiptItems).where(eq(receiptItems.receiptId, r.id))).length).toBe(1);
  });

  it("is idempotent: running the sweep again, or when the file is already gone, is harmless", async () => {
    await setPolicy("days_30");
    const r = await readReceipt();
    await confirm(r.id, r.itemId);
    const later = new Date(Date.now() + 40 * DAY);
    expect((await deleteExpiredReceiptImages(later, { receiptId: r.id })).deleted).toBe(1);
    expect(await deleteExpiredReceiptImages(later, { receiptId: r.id })).toEqual({ deleted: 0, failed: 0 });
    // A file that vanished before the sweep (crash between steps): the record is still brought up to date.
    const r2 = await readReceipt();
    await confirm(r2.id, r2.itemId);
    const { removeStoredFile } = await import("@/server/storage/files");
    await removeStoredFile(r2.key);
    expect((await deleteExpiredReceiptImages(later, { receiptId: r2.id })).deleted).toBe(1);
    expect((await load(r2.id)).imageDeletedAt).not.toBeNull();
  });

  it("keeps photos until the household deletes them when asked to", async () => {
    await setPolicy("keep");
    const r = await readReceipt();
    await confirm(r.id, r.itemId);
    expect((await load(r.id)).imageDeleteAfter).toBeNull();
    await deleteExpiredReceiptImages(new Date(Date.now() + 3650 * DAY), { receiptId: r.id });
    expect(onDisk(r.key)).toBe(true);
    expect((await getReceiptReview(ctx, r.id))?.hasImage).toBe(true);
  });

  it("deletes a discarded receipt's photo straight away, whatever the policy", async () => {
    await setPolicy("keep");
    const r = await readReceipt();
    await discardReceipt(ctx, r.id);
    expect(onDisk(r.key)).toBe(false);
    const after = await load(r.id);
    expect(after.imagePath).toBeNull();
    expect(after.imageDeletedAt).not.toBeNull();
  });

  it("changing the choice applies to photos already stored", async () => {
    await setPolicy("keep");
    const r = await readReceipt();
    await confirm(r.id, r.itemId);
    expect(onDisk(r.key)).toBe(true);
    await setReceiptImageRetention(ctx, "after_review");
    expect(onDisk(r.key)).toBe(false);
    // …and "keep" cancels a removal still pending for a receipt that's done with.
    await setPolicy("days_30");
    const r2 = await readReceipt();
    await confirm(r2.id, r2.itemId);
    expect((await load(r2.id)).imageDeleteAfter).not.toBeNull();
    await setReceiptImageRetention(ctx, "keep");
    expect((await load(r2.id)).imageDeleteAfter).toBeNull();
  });

  it("a photo nobody checks is removed after two weeks", async () => {
    const bytes = await readFile(path.resolve(__dirname, "../fixtures/receipts/woolworths-weekly.png"));
    const before = Date.now();
    const { receiptId } = await createReceiptFromUpload(ctx, { bytes, size: bytes.length }, { allowDuplicate: true });
    const r = await load(receiptId);
    expect(onDisk(r.imagePath)).toBe(true);
    expect(r.imageDeleteAfter!.getTime()).toBeGreaterThanOrEqual(before + UNCHECKED_IMAGE_DAYS * DAY - 5000);
    await deleteExpiredReceiptImages(new Date(Date.now() + (UNCHECKED_IMAGE_DAYS + 1) * DAY), { receiptId });
    expect(onDisk(r.imagePath)).toBe(false);
  });

  it("only ever deletes photos that are due", async () => {
    await setPolicy("keep");
    const r = await readReceipt();
    await deleteExpiredReceiptImages(new Date(), { receiptId: r.id });
    expect(onDisk(r.key)).toBe(true);
  });
  it("removes numbers from item lines before they're stored or remembered", async () => {
    const index = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
    const lines = normalizeExtraction(
      {
        isReceipt: true,
        legible: true,
        store: "Woolworths Metro, 480 Kent St, Sydney NSW 2000",
        purchasedOn: null,
        currency: "AUD",
        subtotal: null,
        total: null,
        problems: [],
        rawText: "",
        ocrConfidence: null,
        provider: "anthropic",
        lines: [
          { raw: "9300633123456 W/M FULL CREAM 2L", name: null, quantity: null, weightKg: null, unitPrice: null, price: 3.1, isGrocery: true },
          { raw: "WW BANANAS KG  jane@example.com", name: null, quantity: null, weightKg: null, unitPrice: null, price: 3, isGrocery: true },
        ],
      },
      index,
    );
    expect(lines.map((l) => l.rawText)).toEqual(["W/M FULL CREAM 2L", "WW BANANAS KG"]);
  });
});
