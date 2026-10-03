import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "@/server/db/client";
import { addUsage, USAGE_RECEIPT_SCANS, usagePeriod } from "@/server/billing/entitlements";
import { buildHouseholdContext } from "@/server/auth/build-context";
import { acceptInvitation, createInvitation } from "@/server/services/household";
import { updateMember } from "@/server/services/members";
import { createReceiptFromUpload } from "@/server/services/receipts";
import { makeHousehold, setHouseholdPlan } from "../helpers/db";

const FIXTURE = path.join(process.cwd(), "tests/fixtures/receipts/woolworths-weekly.png");

afterAll(async () => {
  await pool.end();
});

describe("receipt scan allowance", () => {
  it("stops a new receipt once the month's scans on the plan are used, and says what still works", async () => {
    const free = await makeHousehold({ name: "Scan limit", plan: "free" });
    const bytes = await readFile(FIXTURE);
    // Five scans a month on the free plan: use them up.
    await addUsage(free.household.id, USAGE_RECEIPT_SCANS, usagePeriod(free.household.timezone), 5);
    await expect(createReceiptFromUpload(free, { bytes, size: bytes.length })).rejects.toThrow(/receipt scans.*add items by hand/s);
    // Upgrading lifts it.
    const plus = await setHouseholdPlan(free, "plus");
    await expect(createReceiptFromUpload(plus, { bytes, size: bytes.length })).resolves.toMatchObject({ duplicateOf: null });
  });

  it("a photo that's already been uploaded doesn't cost a scan or hit the limit", async () => {
    const plus = await makeHousehold({ name: "Duplicates", plan: "plus" });
    const bytes = await readFile(FIXTURE);
    const first = await createReceiptFromUpload(plus, { bytes, size: bytes.length });
    const free = await setHouseholdPlan(plus, "free");
    await addUsage(free.household.id, USAGE_RECEIPT_SCANS, usagePeriod(free.household.timezone), 5);
    const again = await createReceiptFromUpload(free, { bytes, size: bytes.length });
    expect(again.duplicateOf?.id).toBe(first.receiptId);
  });

  it("child accounts can't scan receipts", async () => {
    const owner = await makeHousehold({ name: "Kid scan", plan: "family" });
    const other = await makeHousehold({ name: "Kid's own" });
    await acceptInvitation(other.user, (await createInvitation(owner)).code);
    let kid = (await buildHouseholdContext(other.user, owner.household.id))!;
    await updateMember(owner, kid.member.id, { role: "child" });
    kid = (await buildHouseholdContext(other.user, owner.household.id))!;
    const bytes = await readFile(FIXTURE);
    await expect(createReceiptFromUpload(kid, { bytes, size: bytes.length })).rejects.toThrow(/aren't available to this account/);
  });
});

describe("receipt lines can belong to people", () => {
  it("puts a line in the kitchen as the chosen person's, and leaves the rest as the household's", async () => {
    const { systemDb, withUser } = await import("@/server/db/client");
    const { eq } = await import("drizzle-orm");
    const { inventoryItems, receiptItems, receipts } = await import("@/server/db/schema");
    const { confirmReceipt } = await import("@/server/services/receipts");
    const { loadProductIndex } = await import("@/server/services/products");
    const { listMembers } = await import("@/server/services/members");

    const ctx = await makeHousehold({ name: "Receipt owners", plan: "family" });
    const mate = await makeHousehold({ name: "Housemate home" });
    await acceptInvitation(mate.user, (await createInvitation(ctx)).code);
    const housemate = (await listMembers(ctx)).find((m) => !m.isYou)!;

    const index = await withUser(ctx.user.id, (tx) => loadProductIndex(tx, ctx.household.id));
    const cola = index.bySlug.get("diet-cola")!;
    const bread = index.bySlug.get("white-bread")!;
    const [receipt] = await systemDb
      .insert(receipts)
      .values({ householdId: ctx.household.id, uploadedBy: ctx.user.id, status: "needs_review", purchasedAt: new Date(), total: 6 })
      .returning();
    const rows = [];
    for (const [i, p] of [cola, bread].entries()) {
      const [row] = await systemDb
        .insert(receiptItems)
        .values({
          receiptId: receipt.id,
          householdId: ctx.household.id,
          lineIndex: i,
          rawText: p.name.toUpperCase(),
          name: p.name,
          productId: p.id,
          aisle: p.aisle,
          location: p.location,
          quantity: p.packageQuantity,
          unit: p.unit,
          packCount: 1,
          totalPrice: 3,
          matchConfidence: 1,
          isFood: true,
          status: "pending",
        })
        .returning();
      rows.push(row);
    }
    const line = (row: (typeof rows)[number], p: typeof cola, owner?: { ownerMemberId: string | null; visibility?: "household" | "private" }) => ({
      id: row.id,
      include: true,
      name: p.name,
      productId: p.id,
      quantity: p.packageQuantity,
      unit: p.unit,
      packCount: 1,
      location: p.location,
      existingDecision: null,
      ...owner,
    });
    await confirmReceipt(ctx, receipt.id, {
      storeName: "Test",
      purchasedOn: null,
      items: [line(rows[0], cola, { ownerMemberId: housemate.id }), line(rows[1], bread)],
    });
    const items = await systemDb.select().from(inventoryItems).where(eq(inventoryItems.householdId, ctx.household.id));
    expect(items.find((i) => i.productId === cola.id)?.ownerMemberId).toBe(housemate.id);
    expect(items.find((i) => i.productId === bread.id)?.ownerMemberId).toBeNull();
    // A child's chosen owner can't be someone else (they can't scan at all), and a stranger's member id is refused.
    const stranger = await makeHousehold({ name: "Stranger" });
    const [other] = await systemDb
      .insert(receipts)
      .values({ householdId: ctx.household.id, uploadedBy: ctx.user.id, status: "needs_review", purchasedAt: new Date(), total: 3 })
      .returning();
    const [otherRow] = await systemDb
      .insert(receiptItems)
      .values({ receiptId: other.id, householdId: ctx.household.id, lineIndex: 0, rawText: "BREAD", name: bread.name, productId: bread.id, aisle: bread.aisle, location: bread.location, quantity: 1, unit: bread.unit, packCount: 1, matchConfidence: 1, isFood: true, status: "pending" })
      .returning();
    await expect(
      confirmReceipt(ctx, other.id, { storeName: null, purchasedOn: null, items: [line(otherRow, bread, { ownerMemberId: stranger.member.id })] }),
    ).rejects.toThrow();
  });
});
